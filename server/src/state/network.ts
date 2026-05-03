// One IRC network from the client's POV — wraps an IRCConnection,
// maintains the buffer/member state, and emits ServerMessage events for
// the WS layer to broadcast.

import type { Buffer, BufferKind, Member, Network, Message, ServerMessage, ChannelDirectoryEntry } from "@iris-web/shared";
import { IRCConnection, type IRCConnectionConfig } from "../irc/connection";
import type { IRCMessage } from "../irc/types";
import { Numeric } from "../irc/types";
import { cmd } from "../irc/builder";
import * as store from "../db";

let messageSeq = 0;
function nextMessageId(): string { return `${Date.now()}-${++messageSeq}`; }

export type Emitter = (msg: ServerMessage) => void;

export class NetworkSession {
	readonly id: string;
	readonly buffers = new Map<string, BufferState>();
	readonly conn: IRCConnection;
	autoJoinChannels: string[];
	autoConnect: boolean;
	private connected = false;
	private pendingNamesBatch = new Map<string, Member[]>();
	private pendingChannelList: ChannelDirectoryEntry[] | null = null;
	private didAutoJoin = false;
	// Active IRCv3 BATCHes by reference.  We mostly care about
	// `chathistory` so messages that arrive within one are treated as
	// historical (silent insert + msgid dedup, no unread bump).
	private activeBatches = new Map<string, { type: string; target: string }>();
	// In-flight CHATHISTORY requests keyed by target (lowercased).
	// Tells the BATCH closer which event to emit — LATEST means
	// "replay the full buffer", BEFORE means "prepend just the older
	// page and signal whether more exists".
	private chathistoryRequests = new Map<string, {
		kind: "latest" | "before";
		beforeTs?: number;
		limit: number;
	}>();
	// Single-character user mode that the network uses to mark bots
	// (advertised via ISUPPORT BOT=X).  Empty when the network doesn't
	// support the bot-mode convention — we then fall back to the
	// name-based heuristic in the sidebar.
	private botModeChar = "";

	constructor(
		id: string,
		config: IRCConnectionConfig,
		private emit: Emitter,
		opts: { autoJoinChannels?: string[]; autoConnect?: boolean } = {},
	) {
		this.id = id;
		this.autoJoinChannels = opts.autoJoinChannels ?? [];
		this.autoConnect = opts.autoConnect ?? true;
		this.conn = new IRCConnection(config, {
			onState: (state, reason) => this.handleState(state, reason),
			onMessage: (msg) => this.handleMessage(msg),
			onRawIn: (line) => process.env.IRC_DEBUG && console.log(`← ${line}`),
			onRawOut: (line) => process.env.IRC_DEBUG && console.log(`→ ${line}`),
			onSaslResult: (ok, reason) => this.handleSaslResult(ok, reason),
			onCapStatus: (info) => this.handleCapStatus(info),
		});

		// Console buffer for raw server notices and system messages.
		this.openBuffer(this.consoleBufferId(), config.hostname, "console");

		// Hydrate saved buffers so the user sees them in the sidebar
		// (with their history) immediately on reconnect.  Rules:
		//   - Channels: only hydrate ones explicitly in auto-join.
		//     If the user took a channel off the auto-join list they
		//     don't want it cluttering the sidebar after restart.
		//   - Queries (DMs): always hydrate.  Users close DMs with
		//     the X — anything still saved is intentional.
		const autoJoinLower = new Set(this.autoJoinChannels.map(c => {
			const t = c.trim();
			const named = t.startsWith("#") || t.startsWith("&") ? t : `#${t}`;
			return named.toLowerCase();
		}));
		for (const persisted of store.loadBuffersForNetwork(id)) {
			if (persisted.kind === "console") continue;
			if (persisted.kind === "channel" && !autoJoinLower.has(persisted.name.toLowerCase())) continue;
			this.hydrateBuffer(persisted.name, persisted.kind, persisted.topic ?? "");
		}
	}

	private hydrateBuffer(name: string, kind: BufferKind, topic: string): void {
		const id = this.bufferId(name);
		if (this.buffers.has(id)) return;
		const buf = new BufferState(id, this.id, name, kind);
		buf.topic = topic ?? "";
		this.buffers.set(id, buf);
		this.emit({ type: "buffer:opened", buffer: buf.export() });
		const history = store.loadRecentMessages(this.id, name, 200, id);
		if (history.length > 0) {
			this.emit({ type: "history", bufferId: id, messages: history });
		}
	}

	get config(): IRCConnectionConfig { return this.conn.config; }
	get isConnected(): boolean { return this.connected; }

	/// When SASL identified us but the server still landed us on a
	/// suffixed nickname (because another client / dead session is
	/// holding our preferred nick), ask NickServ to GHOST the holder
	/// and then reclaim the nick.  No-op when SASL didn't run, when
	/// we got the nick we asked for, or when no NickServ password is
	/// configured.
	private maybeReclaimNick(): void {
		const wanted = this.config.nickname;
		const current = this.conn.nickname;
		if (current.toLowerCase() === wanted.toLowerCase()) return;
		if (!this.conn.authenticatedViaSASL) return;
		const password = this.config.saslPassword;
		if (!password) return;

		this.systemLine(this.consoleBufferId(),
			`Nickname ${wanted} is held by another session — sending NickServ GHOST to reclaim it.`,
			"system");

		try {
			// Atheme/Solanum syntax: `GHOST <nick> [password]` — we send
			// the password explicitly so it works on networks where the
			// command also requires it (Anope-style).
			this.conn.sendRaw(`PRIVMSG NickServ :GHOST ${wanted} ${password}`);
		} catch { /* ignore */ }

		// Give NickServ a moment to disconnect the ghost session, then
		// take the nick back.  Server's NICK echo will fan out through
		// the existing handler and refresh the sidebar label.
		setTimeout(() => {
			try { this.conn.sendRaw(cmd.nickChange(wanted)); } catch { /* ignore */ }
		}, 1500);
	}

	/// Request the most-recent N messages of server-side chathistory
	/// for a target.  No-op if the server doesn't support the cap;
	/// dedup against our local history happens automatically via
	/// msgid in `saveMessage`.
	/// Emit a `history:older` event with whatever older messages we
	/// already have stored locally for this buffer.  The `exhausted`
	/// flag is true when the local DB has nothing further back —
	/// crucially this fires regardless of whether the network supports
	/// chathistory or whether that request will succeed, so the UI's
	/// "Load older messages" button always gets a definitive answer.
	serveHistoryBeforeFromDB(buf: BufferState, beforeTs: number, limit = 100): void {
		const older = store.loadMessagesBefore(this.id, buf.name, beforeTs, limit, buf.id);
		this.emit({
			type: "history:older",
			bufferId: buf.id,
			messages: older,
			exhausted: older.length < limit,
		});
	}

	requestChathistoryLatest(target: string, limit = 100): void {
		if (!this.connected) return;
		if (!this.hasChathistorySupport()) return;
		this.chathistoryRequests.set(target.toLowerCase(), { kind: "latest", limit });
		try { this.conn.sendRaw(`CHATHISTORY LATEST ${target} * ${limit}`); } catch { /* ignore */ }
	}

	/// Request N messages older than `beforeTs` (epoch ms).  Used by
	/// the client's "load older messages" affordance.
	requestChathistoryBefore(target: string, beforeTs: number, limit = 100): void {
		if (!this.connected) return;
		if (!this.hasChathistorySupport()) return;
		this.chathistoryRequests.set(target.toLowerCase(), { kind: "before", beforeTs, limit });
		const iso = new Date(beforeTs).toISOString();
		try { this.conn.sendRaw(`CHATHISTORY BEFORE ${target} timestamp=${iso} ${limit}`); } catch { /* ignore */ }
	}

	private hasChathistorySupport(): boolean {
		return this.conn.hasCapability("draft/chathistory")
			|| this.conn.hasCapability("chathistory");
	}

	/// True if a message arrived inside an active chathistory batch.
	/// Lets the various command handlers route to a quiet historical
	/// path instead of treating replayed events as live state changes.
	private isHistorical(tags: Record<string, string | true>): boolean {
		const ref = typeof tags["batch"] === "string" ? tags["batch"] : undefined;
		if (!ref) return false;
		return this.activeBatches.get(ref)?.type === "chathistory";
	}

	/// Close a buffer.  For channels this issues a PART (the existing
	/// PART handler then deletes the buffer when the server echoes it
	/// back); for query buffers there's no IRC equivalent of "leave a
	/// DM" — we just delete the buffer + its persisted messages and
	/// emit `buffer:closed` so the sidebar drops it.
	closeBuffer(bufferId: string): void {
		const buf = this.buffers.get(bufferId);
		if (!buf) return;
		if (buf.kind === "console") return;
		if (buf.kind === "channel") {
			try { this.conn.sendRaw(cmd.part(buf.name)); } catch { /* ignore */ }
			return;
		}
		// query buffer — purge from disk + memory.
		store.deleteBufferAndMessages(this.id, buf.name);
		this.buffers.delete(bufferId);
		this.emit({ type: "buffer:closed", bufferId });
	}

	/// Send a typing TAGMSG (IRCv3 +typing client tag) to the channel
	/// or query partner the user is composing in.  Silently no-ops if
	/// `message-tags` wasn't negotiated — the cap is required for any
	/// client tags to be carried.
	sendTyping(bufferId: string, state: "active" | "done"): void {
		if (!this.connected) return;
		if (!this.conn.hasCapability("message-tags")) return;
		const buf = this.buffers.get(bufferId);
		if (!buf || buf.kind === "console") return;
		try { this.conn.sendRaw(`@+typing=${state} TAGMSG ${buf.name}`); } catch { /* ignore */ }
	}

	/// Send `LIST` to the IRC server and stream the result back as a
	/// `channels:result` ServerMessage once `RPL_LISTEND` arrives.
	/// While in flight, emits `channels:listing { loading: true }` so
	/// the UI can show a spinner.  Big networks like Libera return
	/// thousands of channels and several MB of data; the IRC layer
	/// handles framing, we just collect.
	requestChannelList(): void {
		if (!this.connected) {
			this.emit({ type: "channels:result", networkId: this.id, entries: [] });
			return;
		}
		this.pendingChannelList = [];
		this.emit({ type: "channels:listing", networkId: this.id, loading: true });
		try { this.conn.sendRaw("LIST"); } catch {
			this.pendingChannelList = null;
			this.emit({ type: "channels:listing", networkId: this.id, loading: false });
		}
	}

	/// Re-emit recent persisted messages for every open buffer.  Called
	/// after a session resume (`auth` with a known token), since `init`
	/// only carries network/buffer shapes — not the message backlog.
	replayHistory(): void {
		for (const buf of this.buffers.values()) {
			const limit = 200;
			const history = store.loadRecentMessages(this.id, buf.name, limit, buf.id);
			if (history.length > 0) {
				this.emit({ type: "history", bufferId: buf.id, messages: history });
			}
			// Tell the client up front whether there's any older history
			// behind what we just replayed.  Without this, the "Load older
			// messages" button shows for every buffer until the user
			// clicks it once and the server confirms there's nothing —
			// jarring on small buffers (services, freshly-joined channels)
			// where there genuinely never was a backlog.
			if (history.length < limit) {
				this.emit({ type: "history:older", bufferId: buf.id, messages: [], exhausted: true });
			}
		}
	}

	async start(): Promise<void> {
		const cfg = this.conn.config;
		this.systemLine(this.consoleBufferId(),
			`Connecting to ${cfg.hostname}:${cfg.port} (${cfg.useTLS ? "TLS" : "plain"}) as ${cfg.nickname}.`,
			"system");
		// Warn up front when we're going to connect anonymously and the
		// user's nick might be reserved — that's the most common "why
		// did I get the underscore?" footgun.
		if (!cfg.saslPassword || !cfg.saslAccount) {
			this.systemLine(this.consoleBufferId(),
				`No NickServ password set — connecting anonymously. ` +
				`If your nickname is registered, the server will assign a "_"-suffixed nick instead. ` +
				`Add a password via the kebab menu → Edit Server & NickServ.`,
				"error");
		}

		try {
			await this.conn.connect();
		} catch (err) {
			this.systemLine(this.consoleBufferId(), `Connect failed: ${(err as Error).message}`, "error");
		}
	}

	stop(): void {
		this.conn.disconnect();
	}

	// ─── Public helpers used by the WS layer ────────────────────────────

	exportNetwork(): Network {
		return {
			id: this.id,
			name: this.config.hostname,
			hostname: this.config.hostname,
			port: this.config.port,
			useTLS: this.config.useTLS,
			nickname: this.conn.nickname,
			connected: this.connected,
			buffers: [...this.buffers.values()].map(b => b.export()),
			autoJoinChannels: this.autoJoinChannels,
			hasSaslPassword: !!this.config.saslPassword,
			identified: this.conn.authenticatedViaSASL,
			autoConnect: this.autoConnect,
		};
	}

	consoleBufferId(): string { return `${this.id}:console`; }
	bufferId(name: string): string { return `${this.id}:${name.toLowerCase()}`; }

	sendUserInput(bufferId: string, text: string): void {
		const buf = this.buffers.get(bufferId);
		if (!buf) return;

		if (text.startsWith("/")) {
			this.runSlashCommand(buf, text.slice(1));
			return;
		}

		if (buf.kind === "console") {
			this.systemLine(bufferId, "Cannot send to the server console.", "error");
			return;
		}

		try { this.conn.sendRaw(cmd.privmsg(buf.name, text)); } catch { return; }
		// With `echo-message` negotiated the server bounces our own
		// PRIVMSG back to us, which our normal inbound handler records.
		// Adding it locally on send would double-display.  Without the
		// cap we have to record here or our own message wouldn't appear.
		if (!this.conn.hasCapability("echo-message")) {
			this.recordMessage({
				id: nextMessageId(),
				bufferId,
				timestamp: Date.now(),
				from: this.conn.nickname,
				text,
				kind: "privmsg",
				isSelf: true,
			});
		}
	}

	private runSlashCommand(buf: BufferState, body: string): void {
		const sp = body.indexOf(" ");
		const head = (sp === -1 ? body : body.slice(0, sp)).toUpperCase();
		const rest = sp === -1 ? "" : body.slice(sp + 1);

		try {
			switch (head) {
				case "JOIN": {
					const channel = rest.split(" ")[0] ?? "";
					if (!channel) return;
					this.conn.sendRaw(cmd.join(channel));
					break;
				}
				case "PART": {
					const target = rest || (buf.kind === "channel" ? buf.name : "");
					if (!target) return;
					this.conn.sendRaw(cmd.part(target));
					break;
				}
				case "NICK":
					if (rest) this.conn.sendRaw(cmd.nickChange(rest.split(" ")[0] ?? ""));
					break;
				case "MSG": {
					const sp2 = rest.indexOf(" ");
					if (sp2 === -1) return;
					this.conn.sendRaw(cmd.privmsg(rest.slice(0, sp2), rest.slice(sp2 + 1)));
					break;
				}
				case "ME":
					if (buf.kind !== "channel" && buf.kind !== "query") return;
					this.conn.sendRaw(cmd.privmsg(buf.name, `ACTION ${rest}`));
					if (!this.conn.hasCapability("echo-message")) {
						this.recordMessage({
							id: nextMessageId(),
							bufferId: buf.id,
							timestamp: Date.now(),
							from: this.conn.nickname,
							text: rest,
							kind: "action",
							isSelf: true,
						});
					}
					break;
				case "RAW":
					if (rest) this.conn.sendRaw(rest);
					break;
				default:
					this.conn.sendRaw(body);
			}
		} catch (err) {
			this.systemLine(buf.id, `Command failed: ${(err as Error).message}`, "error");
		}
	}

	// ─── State machine ──────────────────────────────────────────────────

	private handleCapStatus(info: { advertised: string[]; haveSaslCreds: boolean; saslAdvertised: boolean }): void {
		// Only complain when SASL was wanted but unavailable — quiet
		// otherwise; the cap dump was useful during the SASL bringup
		// debug but is just noise for normal users now that it works.
		if (info.haveSaslCreds && !info.saslAdvertised) {
			this.systemLine(this.consoleBufferId(),
				`Server doesn't advertise SASL — your password can't be used. ` +
				`Either the server doesn't support SASL or it's behind a different cap name.`,
				"error");
		}
	}

	private handleSaslResult(ok: boolean, reason?: string): void {
		if (ok) {
			this.systemLine(this.consoleBufferId(),
				`Identified to NickServ via SASL as ${this.config.saslAccount}.`,
				"system");
		} else {
			const tail = reason ? ` (${reason})` : "";
			this.systemLine(this.consoleBufferId(),
				`SASL authentication failed${tail}. ` +
				`Connecting anonymously — your nickname may be appended with "_" if it's reserved. ` +
				`Check the NickServ password in Edit Server, then Reconnect.`,
				"error");
		}
		this.emit({ type: "network:status", networkId: this.id, connected: this.connected, identified: ok });
	}

	private handleState(state: string, reason?: string): void {
		const wasConnected = this.connected;
		this.connected = state === "connected";
		if (wasConnected !== this.connected) {
			// On disconnect, reset identified — a fresh connect/reconnect
			// re-runs SASL and will emit a new identified value if it works.
			this.emit({ type: "network:status", networkId: this.id, connected: this.connected, identified: this.connected ? this.conn.authenticatedViaSASL : false });
		}
		if (state === "failed" || state === "disconnected") {
			const detail = reason ? ` (${reason})` : "";
			this.systemLine(this.consoleBufferId(), `Disconnected${detail}.`, "error");
		}
	}

	private handleMessage(msg: IRCMessage): void {
		const c = msg.command;
		const senderNick = msg.source?.kind === "user" ? msg.source.nick
			: msg.source?.kind === "server" ? msg.source.name
			: this.config.hostname;

		switch (c.keyword) {
			case "PRIVMSG":
			case "NOTICE": {
				const isFromUs = senderNick.toLowerCase() === this.conn.nickname.toLowerCase();
				// HistServ is Ergo's synthetic user for legacy chathistory
				// replay (when `draft/event-playback` isn't negotiated).
				// We negotiate that cap so we get real JOIN/PART/QUIT
				// events instead — anything from `HistServ` is unwanted noise.
				if (senderNick.toLowerCase() === "histserv") break;
				const isChannel = /^[#&+!]/.test(c.target);
				// Server-originated NOTICE/PRIVMSG (source kind = "server",
				// e.g. "*** Notice -- foo" from irc.example.org itself)
				// belongs in the console.  Without this we'd open a query
				// buffer named after the hostname, which then sits next to
				// the console (whose display name is also the hostname) —
				// looks like a duplicate buffer to the user.
				const fromServer = msg.source?.kind === "server" || !msg.source;
				const conversationPartner = isFromUs ? c.target : senderNick;
				const buf = isChannel
					? this.openBuffer(this.bufferId(c.target), c.target, "channel")
					: fromServer
						? this.buffers.get(this.consoleBufferId())!
						: this.openBuffer(this.bufferId(conversationPartner), conversationPartner, "query");

				const { kind, text } = decodeCTCP(c.text, c.keyword === "NOTICE");
				const timestamp = msg.tags["time"] && typeof msg.tags["time"] === "string"
					? new Date(msg.tags["time"]).getTime()
					: Date.now();
				const msgid = typeof msg.tags["msgid"] === "string" ? msg.tags["msgid"] : undefined;

				// If this message arrived inside a chathistory batch, take
				// a silent path: insert into the DB with msgid dedup and
				// DON'T fire `msg`.  The batch closer will replay the
				// merged buffer history in one shot.
				const batchRef = typeof msg.tags["batch"] === "string" ? msg.tags["batch"] : undefined;
				const inChathistory = batchRef
					? this.activeBatches.get(batchRef)?.type === "chathistory"
					: false;

				const message: Message = {
					id: nextMessageId(),
					bufferId: buf.id,
					timestamp,
					from: senderNick,
					text,
					kind,
					isSelf: isFromUs,
				};

				if (inChathistory) {
					store.saveMessage(this.id, buf.name, message, msgid);
				} else {
					this.recordMessage(message, msgid);
				}
				break;
			}

			case "JOIN": {
				const channel = c.channels[0] ?? "";
				if (!channel) break;
				const isUs = senderNick.toLowerCase() === this.conn.nickname.toLowerCase();
				const ts = msg.tags["time"] && typeof msg.tags["time"] === "string"
					? new Date(msg.tags["time"]).getTime() : Date.now();
				const msgid = typeof msg.tags["msgid"] === "string" ? msg.tags["msgid"] : undefined;
				if (this.isHistorical(msg.tags)) {
					// Chathistory replay: store as a presence message but
					// don't mutate live member state or surface as "You joined".
					const buf = this.buffers.get(this.bufferId(channel));
					if (buf) store.saveMessage(this.id, buf.name, {
						id: nextMessageId(), bufferId: buf.id, timestamp: ts,
						from: senderNick, text: `joined ${channel}`, kind: "join",
					}, msgid);
					break;
				}
				if (isUs) {
					this.openBuffer(this.bufferId(channel), channel, "channel");
					this.requestChathistoryLatest(channel);
				} else {
					const buf = this.buffers.get(this.bufferId(channel));
					if (buf) {
						const userhost = msg.source?.kind === "user"
							? { user: msg.source.user, host: msg.source.host }
							: {};
						const account = c.account && c.account !== "*" ? c.account : undefined;
						buf.members.set(senderNick, {
							nickname: senderNick,
							prefixes: "",
							...userhost,
							...(account ? { account } : {}),
						});
						this.broadcastMembers(buf);
						this.recordMessage({
							id: nextMessageId(), bufferId: buf.id, timestamp: ts,
							from: senderNick, text: `joined ${channel}`, kind: "join",
						}, msgid);
					}
				}
				break;
			}

			case "PART": {
				const buf = this.buffers.get(this.bufferId(c.channel));
				if (!buf) break;
				const isUs = senderNick.toLowerCase() === this.conn.nickname.toLowerCase();
				const ts = msg.tags["time"] && typeof msg.tags["time"] === "string"
					? new Date(msg.tags["time"]).getTime() : Date.now();
				const msgid = typeof msg.tags["msgid"] === "string" ? msg.tags["msgid"] : undefined;
				const text = c.reason ? `left ${c.channel} (${c.reason})` : `left ${c.channel}`;
				if (this.isHistorical(msg.tags)) {
					store.saveMessage(this.id, buf.name, {
						id: nextMessageId(), bufferId: buf.id, timestamp: ts,
						from: senderNick, text, kind: "part",
					}, msgid);
					break;
				}
				if (isUs) {
					this.buffers.delete(buf.id);
					this.emit({ type: "buffer:closed", bufferId: buf.id });
				} else {
					buf.members.delete(senderNick);
					this.broadcastMembers(buf);
					this.recordMessage({
						id: nextMessageId(), bufferId: buf.id, timestamp: ts,
						from: senderNick, text, kind: "part",
					}, msgid);
				}
				break;
			}

			case "QUIT": {
				const ts = msg.tags["time"] && typeof msg.tags["time"] === "string"
					? new Date(msg.tags["time"]).getTime() : Date.now();
				const msgid = typeof msg.tags["msgid"] === "string" ? msg.tags["msgid"] : undefined;
				const text = c.reason ? `quit (${c.reason})` : `quit`;
				const historical = this.isHistorical(msg.tags);
				for (const buf of this.buffers.values()) {
					if (historical) {
						// Without member state to track, only record the
						// quit in channels where the sender is currently a member.
						if (!buf.members.has(senderNick)) continue;
						store.saveMessage(this.id, buf.name, {
							id: nextMessageId(), bufferId: buf.id, timestamp: ts,
							from: senderNick, text, kind: "quit",
						}, msgid);
					} else if (buf.members.delete(senderNick)) {
						this.broadcastMembers(buf);
						this.recordMessage({
							id: nextMessageId(), bufferId: buf.id, timestamp: ts,
							from: senderNick, text, kind: "quit",
						}, msgid);
					}
				}
				break;
			}

			case "NICK": {
				const ts = msg.tags["time"] && typeof msg.tags["time"] === "string"
					? new Date(msg.tags["time"]).getTime() : Date.now();
				const msgid = typeof msg.tags["msgid"] === "string" ? msg.tags["msgid"] : undefined;
				const historical = this.isHistorical(msg.tags);
				const isUs = senderNick.toLowerCase() === this.conn.nickname.toLowerCase()
					|| c.nick.toLowerCase() === this.conn.nickname.toLowerCase();
				for (const buf of this.buffers.values()) {
					const m = buf.members.get(senderNick);
					if (historical) {
						if (!m) continue;
						store.saveMessage(this.id, buf.name, {
							id: nextMessageId(), bufferId: buf.id, timestamp: ts,
							from: senderNick, text: `is now known as ${c.nick}`, kind: "nick",
						}, msgid);
					} else if (m) {
						buf.members.delete(senderNick);
						buf.members.set(c.nick, { ...m, nickname: c.nick });
						this.broadcastMembers(buf);
						this.recordMessage({
							id: nextMessageId(), bufferId: buf.id, timestamp: ts,
							from: senderNick, text: `is now known as ${c.nick}`, kind: "nick",
						}, msgid);
					}
				}
				// Push the updated network shape so the sidebar's
				// "Connected · <nick>" label reflects our actual nick
				// after a /NICK echo or server-forced rename.
				if (!historical && isUs) {
					this.emit({ type: "network:added", network: this.exportNetwork() });
				}
				break;
			}

			case "TOPIC": {
				const buf = this.buffers.get(this.bufferId(c.channel));
				if (!buf) break;
				buf.topic = c.topic ?? "";
				store.saveBuffer(this.id, buf.name, buf.kind, buf.topic);
				this.emit({ type: "buffer:topic", bufferId: buf.id, topic: buf.topic });
				break;
			}

			case "BATCH": {
				if (c.isStart) {
					this.activeBatches.set(c.ref, {
						type: c.batchType ?? "",
						target: c.params[0] ?? "",
					});
				} else {
					const batch = this.activeBatches.get(c.ref);
					this.activeBatches.delete(c.ref);
					if (batch?.type === "chathistory") {
						const buf = this.buffers.get(this.bufferId(batch.target));
						const req = this.chathistoryRequests.get(batch.target.toLowerCase());
						this.chathistoryRequests.delete(batch.target.toLowerCase());
						if (!buf || !req) break;
						if (req.kind === "latest") {
							// Replay full buffer state so the client
							// renders the merged + sorted set.
							const history = store.loadRecentMessages(this.id, buf.name, 200, buf.id);
							this.emit({ type: "history", bufferId: buf.id, messages: history });
						} else {
							// Pagination: load just the page of messages
							// older than the requested cutoff and signal
							// `exhausted` if the server returned fewer
							// than we asked for.
							const older = store.loadMessagesBefore(
								this.id, buf.name, req.beforeTs!, req.limit, buf.id,
							);
							this.emit({
								type: "history:older",
								bufferId: buf.id,
								messages: older,
								exhausted: older.length < req.limit,
							});
						}
					}
				}
				break;
			}

			case "TAGMSG": {
				// IRCv3 client tag carrier — currently we only care about
				// `+typing`.  Ignore our own echo so we don't show a
				// "you are typing" indicator about ourselves.
				const isFromUs = senderNick.toLowerCase() === this.conn.nickname.toLowerCase();
				if (isFromUs) break;
				const typing = msg.tags["+typing"];
				if (typeof typing !== "string") break;
				const isChannel = /^[#&+!]/.test(c.target);
				const conversationPartner = isChannel ? c.target : senderNick;
				const buf = this.buffers.get(this.bufferId(conversationPartner));
				if (!buf) break;
				const state = typing === "active" || typing === "paused" ? "active" : "done";
				this.emit({
					type: "typing",
					bufferId: buf.id,
					nickname: senderNick,
					state,
				});
				break;
			}

			case "NUMERIC":
				this.handleNumeric(c.code, c.params);
				break;

			case "FAIL":
			case "WARN":
			case "NOTE": {
				const tag = c.command ? `${c.command} ${c.code}` : c.code;
				const ctx = c.context.length > 0 ? ` (${c.context.join(" ")})` : "";
				const text = `${tag}${ctx}: ${c.description}`;
				this.systemLine(this.consoleBufferId(), text, c.keyword === "FAIL" ? "error" : "system");
				break;
			}

			default:
				// Unknown verbs / unhandled — just log to console.
				if (c.keyword === "UNKNOWN") {
					this.systemLine(this.consoleBufferId(), msg.raw, "system");
				}
				break;
		}
	}

	private handleNumeric(code: number, params: string[]): void {
		switch (code) {
			case Numeric.RPL_ISUPPORT: {
				// Tokens look like KEY or KEY=VALUE.  We only care about
				// `BOT=X` for the bot mode character.
				for (const token of params.slice(1, -1)) {
					const eq = token.indexOf("=");
					const key = eq === -1 ? token : token.slice(0, eq);
					const value = eq === -1 ? "" : token.slice(eq + 1);
					if (key.toUpperCase() === "BOT" && value.length === 1) {
						this.botModeChar = value;
					}
				}
				break;
			}

			case Numeric.RPL_WHOREPLY: {
				// "<me> <channel> <user> <host> <server> <nick> <flags> :<hopcount> <realname>"
				const channel = params[1] ?? "";
				const user = params[2];
				const host = params[3];
				const nick = params[5] ?? "";
				const flags = params[6] ?? "";
				const buf = this.buffers.get(this.bufferId(channel));
				if (!buf) break;
				const member = buf.members.get(nick);
				if (!member) break;
				const isBot = !!this.botModeChar && flags.includes(this.botModeChar);
				const updated = { ...member, user, host, isBot };
				buf.members.set(nick, updated);
				// Don't broadcast on every WHO line — flush at ENDOFWHO.
				break;
			}

			case Numeric.RPL_ENDOFWHO: {
				const channel = params[1] ?? "";
				const buf = this.buffers.get(this.bufferId(channel));
				if (buf) this.broadcastMembers(buf);
				break;
			}

			case Numeric.RPL_WELCOME:
			case Numeric.RPL_MYINFO:
				this.systemLine(this.consoleBufferId(), params[params.length - 1] ?? "", "system");
				// Also republish the (possibly renamed) network state.
				this.emit({ type: "network:status", networkId: this.id, connected: true, identified: this.conn.authenticatedViaSASL });
				if (code === Numeric.RPL_WELCOME && !this.didAutoJoin) {
					this.didAutoJoin = true;
					this.maybeReclaimNick();
					for (const channel of this.autoJoinChannels) {
						const target = channel.trim();
						if (!target) continue;
						const named = target.startsWith("#") || target.startsWith("&") ? target : `#${target}`;
						try { this.conn.sendRaw(cmd.join(named)); } catch { /* ignore */ }
					}
					const skip = new Set(this.autoJoinChannels.map(c =>
						(c.startsWith("#") || c.startsWith("&") ? c : `#${c}`).toLowerCase()));
					for (const buf of this.buffers.values()) {
						if (buf.kind === "console") continue;
						if (skip.has(buf.name.toLowerCase())) continue;
						this.requestChathistoryLatest(buf.name);
					}
				}
				break;
			case Numeric.RPL_TOPIC: {
				const channel = params[1] ?? "";
				const topic = params[2] ?? "";
				const buf = this.buffers.get(this.bufferId(channel));
				if (buf) {
					buf.topic = topic;
					store.saveBuffer(this.id, buf.name, buf.kind, topic);
					this.emit({ type: "buffer:topic", bufferId: buf.id, topic });
				}
				break;
			}
			case Numeric.RPL_LISTSTART:
				// Some servers prepend a header row — reset the accumulator
				// in case requestChannelList wasn't called (we still want a
				// meaningful payload at the end).
				if (this.pendingChannelList == null) this.pendingChannelList = [];
				break;

			case Numeric.RPL_LIST:
				if (this.pendingChannelList) {
					// Wire shape: `<me> <channel> <userCount> :<topic>`
					this.pendingChannelList.push({
						name: params[1] ?? "",
						userCount: Number(params[2] ?? "0") || 0,
						topic: params[3] ?? "",
					});
				}
				break;

			case Numeric.RPL_LISTEND:
				if (this.pendingChannelList) {
					this.emit({
						type: "channels:result",
						networkId: this.id,
						entries: this.pendingChannelList,
					});
					this.pendingChannelList = null;
				}
				this.emit({ type: "channels:listing", networkId: this.id, loading: false });
				break;

			case Numeric.RPL_NAMREPLY: {
				// "<me> <symbol> <channel> :<prefix><nick>[!user@host] ..."
				// With `userhost-in-names`, each entry is the full mask;
				// without it, just the bare nick.
				const channel = params[2] ?? "";
				const list = (params[3] ?? "").split(" ").filter(Boolean);
				const members: Member[] = list.map(token => {
					const prefixMatch = token.match(/^([~&@%+]+)/);
					const prefixes = prefixMatch?.[1] ?? "";
					const remainder = token.slice(prefixes.length);
					const userhostMatch = remainder.match(/^([^!]+)!([^@]+)@(.+)$/);
					if (userhostMatch) {
						return {
							nickname: userhostMatch[1]!,
							prefixes,
							user: userhostMatch[2],
							host: userhostMatch[3],
						};
					}
					return { nickname: remainder, prefixes };
				});
				const existing = this.pendingNamesBatch.get(channel) ?? [];
				this.pendingNamesBatch.set(channel, [...existing, ...members]);
				break;
			}
			case Numeric.RPL_ENDOFNAMES: {
				const channel = params[1] ?? "";
				const buf = this.buffers.get(this.bufferId(channel));
				if (buf) {
					buf.members.clear();
					for (const m of this.pendingNamesBatch.get(channel) ?? []) {
						buf.members.set(m.nickname, m);
					}
					this.broadcastMembers(buf);
					// Follow up with WHO so we get user mode flags
					// (specifically the bot flag) and richer host info.
					if (this.botModeChar) {
						try { this.conn.sendRaw(`WHO ${channel}`); } catch { /* ignore */ }
					}
				}
				this.pendingNamesBatch.delete(channel);
				break;
			}
			default:
				// Render most other numerics into the console for now.
				if (params.length > 0) {
					this.systemLine(this.consoleBufferId(), params.slice(1).join(" ") || params[0]!, "system");
				}
				break;
		}
	}

	// ─── Buffer plumbing ────────────────────────────────────────────────

	private openBuffer(id: string, name: string, kind: BufferKind): BufferState {
		const existing = this.buffers.get(id);
		if (existing) return existing;
		const buf = new BufferState(id, this.id, name, kind);
		// For DM buffers, infer bot status by scanning channel member
		// lists — anyone we've seen with the +<botModeChar> flag in any
		// shared channel is treated as a bot for DM purposes.
		if (kind === "query") {
			for (const other of this.buffers.values()) {
				const m = other.members.get(name);
				if (m?.isBot) { buf.isBot = true; break; }
			}
		}
		this.buffers.set(id, buf);
		store.saveBuffer(this.id, name, kind, "");
		this.emit({ type: "buffer:opened", buffer: buf.export() });
		// Replay recent persisted history into the client immediately so a
		// freshly-opened buffer isn't blank.
		const limit = 200;
		const history = store.loadRecentMessages(this.id, name, limit, id);
		if (history.length > 0) {
			this.emit({ type: "history", bufferId: id, messages: history });
		}
		// Same exhaustion hint as replayHistory — hide "Load older" up
		// front for freshly-opened buffers with nothing further back.
		if (history.length < limit) {
			this.emit({ type: "history:older", bufferId: id, messages: [], exhausted: true });
		}
		return buf;
	}

	private broadcastMembers(buf: BufferState): void {
		this.emit({ type: "buffer:members", bufferId: buf.id, members: [...buf.members.values()] });
	}

	private recordMessage(message: Message, msgid?: string): void {
		const buf = this.buffers.get(message.bufferId);
		if (!buf) return;
		// Returns false if this msgid was already stored — happens
		// when chathistory replays something we already had locally,
		// or with quirky echo-message implementations.
		const inserted = store.saveMessage(this.id, buf.name, message, msgid);
		if (!inserted) return;
		buf.history.push(message);
		if (buf.history.length > 500) buf.history.shift();
		this.emit({ type: "msg", message });
	}

	private systemLine(bufferId: string, text: string, kind: Message["kind"]): void {
		this.openBufferIfMissing(bufferId);
		this.recordMessage({
			id: nextMessageId(),
			bufferId,
			timestamp: Date.now(),
			from: "*",
			text,
			kind,
		});
	}

	private openBufferIfMissing(bufferId: string): void {
		if (!this.buffers.get(bufferId)) {
			this.openBuffer(bufferId, this.config.hostname, "console");
		}
	}
}

export class BufferState {
	members = new Map<string, Member>();
	history: Message[] = [];
	topic = "";
	isBot = false;

	constructor(
		public id: string,
		public networkId: string,
		public name: string,
		public kind: BufferKind,
	) {}

	export(): Buffer {
		return {
			id: this.id,
			networkId: this.networkId,
			name: this.name,
			kind: this.kind,
			topic: this.topic,
			members: [...this.members.values()],
			unreadCount: 0,
			highlightCount: 0,
			isBot: this.isBot,
		};
	}
}

function decodeCTCP(text: string, isNotice: boolean): { kind: Message["kind"]; text: string } {
	const ctcp = text.match(/^(\w+)(?: (.*))?$/);
	if (ctcp && ctcp[1]?.toUpperCase() === "ACTION") {
		return { kind: "action", text: ctcp[2] ?? "" };
	}
	return { kind: isNotice ? "notice" : "privmsg", text };
}
