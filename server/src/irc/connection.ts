// IRCConnection — one socket to one IRC server.  Handles framing,
// CAP + SASL PLAIN negotiation, NICK/USER, and PING/PONG; surfaces every
// inbound message via an event listener.  No buffer/network model lives
// here — that's the caller's job.

import type { Socket } from "bun";
import { parse } from "./parser";
import type { IRCMessage } from "./types";
import { Numeric } from "./types";
import { cmd } from "./builder";

const DESIRED_CAPS = [
	"server-time",
	"multi-prefix",
	"away-notify",
	"account-tag",
	"echo-message",
	"message-tags",     // required carrier for IRCv3 client tags (+typing, etc.)
	"batch",            // BATCH wrapping for chathistory + multiline
	"draft/chathistory",// Ergo's name; servers may also offer plain "chathistory"
	"chathistory",
	// When negotiated, chathistory replays presence events as actual
	// JOIN/PART/QUIT/NICK messages (within the batch) instead of as
	// PRIVMSGs from a synthetic `HistServ` user.  Lets us filter them
	// with the same hide-join-part-quit toggle as live presence.
	"draft/event-playback",
	"standard-replies",   // structured FAIL/WARN/NOTE error replies
	"extended-join",      // JOIN includes joiner's account + realname
	"userhost-in-names",  // NAMES carries nick!user@host instead of bare nick
];

export interface IRCConnectionConfig {
	hostname: string;
	port: number;
	useTLS: boolean;
	nickname: string;
	username?: string;
	realname?: string;
	serverPassword?: string;
	saslAccount?: string;
	saslPassword?: string;
}

export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "registering"
	| "connected"
	| "failed";

export interface IRCConnectionListener {
	onState?(state: ConnectionState, reason?: string): void;
	onMessage?(msg: IRCMessage): void;
	onRawIn?(line: string): void;
	onRawOut?(line: string): void;
	/// Fired once SASL completes (or times out / is rejected).  ok=true
	/// means we're identified to NickServ via SASL; ok=false means we're
	/// connected but as anonymous, and the server may have assigned a
	/// "_"-suffixed nick if our real one was reserved.
	onSaslResult?(ok: boolean, reason?: string): void;
	/// Fired right after the CAP LS reply is received, before CAP REQ.
	/// Lets the host show what the server actually offered so the user
	/// can debug why SASL got skipped.
	onCapStatus?(info: { advertised: string[]; haveSaslCreds: boolean; saslAdvertised: boolean }): void;
}

interface SocketData {
	conn: IRCConnection;
}

export class IRCConnection {
	private socket: Socket<SocketData> | null = null;
	// 60s heartbeat — without this, IRC servers drop the connection
	// after a few minutes of silence (libera/solanum is ~5 min).  We
	// only respond to inbound PINGs by default; this sends our own.
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	// Watchdog: if we go this long without ANY byte from the server,
	// we treat the connection as dead and force-close.  Catches the
	// case where the OS never delivers a close callback (server side
	// reaped us, NAT mapping dropped, network blackholed, etc.).
	private lastInboundAt = Date.now();
	private static readonly STALE_TIMEOUT_MS = 120_000;
	private buf = "";
	private state: ConnectionState = "disconnected";
	private listener: IRCConnectionListener;
	private negotiatedCaps = new Set<string>();
	private capLSAccumulator = new Set<string>();
	private capLSResolver?: (caps: Set<string>) => void;
	private capReqResolver?: (ok: boolean) => void;
	private openResolver?: () => void;
	private authChallengeResolver?: () => void;
	private saslResultResolver?: (ok: boolean, reason?: string) => void;
	private didAuthenticateSASL = false;
	private currentNick: string;

	constructor(public config: IRCConnectionConfig, listener: IRCConnectionListener = {}) {
		this.listener = listener;
		this.currentNick = config.nickname;
	}

	get nickname(): string { return this.currentNick; }
	get authenticatedViaSASL(): boolean { return this.didAuthenticateSASL; }
	hasCapability(name: string): boolean { return this.negotiatedCaps.has(name); }
	get connectionState(): ConnectionState { return this.state; }

	async connect(): Promise<void> {
		if (this.state !== "disconnected" && this.state !== "failed") return;
		this.transition("connecting");

		// Wait for the `open` callback before sending anything.  With
		// TLS, `Bun.connect`'s await resolves when the TCP handshake is
		// done — but the TLS handshake is still in flight, and writes
		// during that window get silently dropped.  The `open` callback
		// fires after BOTH handshakes complete, which is when it's
		// actually safe to start sending IRC commands.
		const openPromise = new Promise<void>(resolve => { this.openResolver = resolve; });

		this.socket = await Bun.connect<SocketData>({
			hostname: this.config.hostname,
			port: this.config.port,
			tls: this.config.useTLS,
			data: { conn: this },
			socket: {
				open:    (sock)       => sock.data.conn.onSocketOpen(),
				data:    (sock, data) => sock.data.conn.onSocketData(data),
				close:   (sock)       => sock.data.conn.onSocketClose("closed"),
				error:   (sock, err)  => sock.data.conn.onSocketClose(`error: ${err.message}`),
				connectError: (sock, err) => sock.data.conn.onConnectError(err.message),
			},
		});

		// Cap the open wait so a TLS misconfiguration can't hang us
		// silently — if 10s pass without an open callback we abort.
		await Promise.race([
			openPromise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("timed out waiting for socket open / TLS handshake")), 10_000)),
		]);

		this.transition("registering");
		await this.performRegistration();
	}

	private onSocketOpen(): void {
		const resolve = this.openResolver;
		this.openResolver = undefined;
		resolve?.();
	}

	disconnect(reason = "iris-web disconnecting"): void {
		if (this.socket && this.state !== "disconnected") {
			try { this.sendRaw(cmd.quit(reason)); } catch { /* ignore */ }
			this.socket.end();
		}
		this.cleanup();
		this.transition("disconnected");
	}

	sendRaw(line: string): void {
		if (!this.socket) throw new Error("not connected");
		this.socket.write(line + "\r\n");
		this.listener.onRawOut?.(line);
	}

	// ─── Socket callbacks ───────────────────────────────────────────────

	private onSocketData(chunk: Buffer | Uint8Array | string): void {
		this.lastInboundAt = Date.now();
		this.buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		// Frame on \n; handle \r\n and bare \n the same way.
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) !== -1) {
			let line = this.buf.slice(0, idx);
			this.buf = this.buf.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			this.handleLine(line);
		}
	}

	private onSocketClose(reason: string): void {
		this.cleanup();
		this.transition("disconnected", reason);
	}

	private onConnectError(reason: string): void {
		this.cleanup();
		this.transition("failed", reason);
	}

	private handleLine(line: string): void {
		this.listener.onRawIn?.(line);
		const msg = parse(line);
		this.processInbound(msg);
		this.listener.onMessage?.(msg);
	}

	private processInbound(msg: IRCMessage): void {
		const c = msg.command;

		if (c.keyword === "PING") {
			try { this.sendRaw(cmd.pong(c.params[0] ?? "")); } catch { /* ignore */ }
			return;
		}

		if (c.keyword === "ERROR") {
			this.transition("failed", c.reason);
			return;
		}

		if (c.keyword === "CAP") {
			this.handleCAP(c.sub, c.payload, c.rawParams);
			return;
		}

		if (c.keyword === "AUTHENTICATE") {
			if (c.data === "+") this.authChallengeResolver?.();
			return;
		}

		if (c.keyword === "NUMERIC") {
			this.handleNumeric(c.code, c.params);
			return;
		}

		if (c.keyword === "NICK" && msg.source?.kind === "user") {
			if (msg.source.nick.toLowerCase() === this.currentNick.toLowerCase()) {
				this.currentNick = c.nick;
			}
		}
	}

	private handleCAP(sub: string, payload: string | undefined, rawParams: string[]): void {
		const names = (payload ?? "")
			.split(" ")
			.map(n => n.startsWith("-") ? n.slice(1) : n)
			.map(n => n.split("=")[0] ?? n)
			.filter(Boolean);

		switch (sub) {
			case "LS": {
				for (const n of names) this.capLSAccumulator.add(n);
				const isContinuation = rawParams.length >= 2
					&& rawParams[rawParams.length - 2] === "*";
				if (!isContinuation) {
					this.capLSResolver?.(new Set(this.capLSAccumulator));
					this.capLSResolver = undefined;
				}
				break;
			}
			case "ACK":
			case "NEW":
				for (const n of names) this.negotiatedCaps.add(n);
				if (sub === "ACK") {
					this.capReqResolver?.(true);
					this.capReqResolver = undefined;
				}
				break;
			case "NAK":
				this.capReqResolver?.(false);
				this.capReqResolver = undefined;
				break;
			case "DEL":
				for (const n of names) this.negotiatedCaps.delete(n);
				break;
		}
	}

	private handleNumeric(code: number, params: string[]): void {
		switch (code) {
			case Numeric.SASL_SUCCESS:
				this.saslResultResolver?.(true);
				this.saslResultResolver = undefined;
				break;
			case Numeric.SASL_FAILED:
			case Numeric.SASL_FAIL:
			case Numeric.SASL_ABORTED:
			case Numeric.SASL_ALREADY:
			case Numeric.SASL_MECHS:
				this.saslResultResolver?.(false, params[params.length - 1]);
				this.saslResultResolver = undefined;
				break;
		}

		if (code === Numeric.RPL_WELCOME && this.state === "registering") {
			if (params[0]) this.currentNick = params[0];
			this.transition("connected");
			this.startPingTimer();
		}

		if (code === Numeric.ERR_NICKNAMEINUSE && this.state === "registering") {
			const candidate = this.currentNick + "_";
			try { this.sendRaw(cmd.nickChange(candidate)); } catch { /* ignore */ }
			this.currentNick = candidate;
		}
	}

	// ─── Registration & SASL ────────────────────────────────────────────

	private async performRegistration(): Promise<void> {
		if (this.config.serverPassword) {
			this.sendRaw(cmd.pass(this.config.serverPassword));
		}

		this.capLSAccumulator.clear();
		this.sendRaw("CAP LS 302");
		// 12s — Libera and other large networks can stall on reverse-DNS
		// or ident lookup before they reply to CAP LS.  5s was too tight
		// and led to false "server didn't advertise SASL" diagnostics.
		const advertised = await this.awaitCapLS(12000);

		const haveSaslCreds = !!this.config.saslAccount && !!this.config.saslPassword;
		const saslAdvertised = [...advertised].some(n => n.toLowerCase() === "sasl");
		const wantsSASL = haveSaslCreds && saslAdvertised;

		this.listener.onCapStatus?.({
			advertised: [...advertised].sort(),
			haveSaslCreds,
			saslAdvertised,
		});

		const requested = DESIRED_CAPS.filter(c => advertised.has(c));
		if (wantsSASL) requested.push("sasl");

		if (requested.length > 0) {
			this.sendRaw(`CAP REQ :${requested.join(" ")}`);
			await this.awaitCapReq(5000);
		}

		if (wantsSASL && this.negotiatedCaps.has("sasl")) {
			await this.performSASLPlain(
				this.config.saslAccount!,
				this.config.saslPassword!,
			);
		} else if (haveSaslCreds && !this.negotiatedCaps.has("sasl")) {
			// We have credentials but never authenticated.  Surface the
			// reason so it doesn't silently degrade into a `_`-suffixed nick.
			const why = !saslAdvertised
				? "server did not advertise SASL capability"
				: "server did not enable SASL after CAP REQ (NAK or no ACK)";
			this.listener.onSaslResult?.(false, why);
		}

		this.sendRaw("CAP END");
		this.sendRaw(cmd.nick(this.config.nickname));
		this.sendRaw(cmd.user(
			this.config.username ?? this.config.nickname,
			this.config.realname ?? this.config.nickname,
		));
	}

	private async performSASLPlain(account: string, password: string): Promise<void> {
		this.sendRaw("AUTHENTICATE PLAIN");
		await this.awaitAuthChallenge(5000);

		// PLAIN payload: \0<authcid>\0<password>
		const sep = String.fromCharCode(0);
		const payload = sep + account + sep + password;
		const encoded = Buffer.from(payload, "utf8").toString("base64");

		if (encoded.length < 400) {
			this.sendRaw(`AUTHENTICATE ${encoded}`);
		} else {
			for (let i = 0; i < encoded.length; i += 400) {
				this.sendRaw(`AUTHENTICATE ${encoded.slice(i, i + 400)}`);
			}
			if (encoded.length % 400 === 0) this.sendRaw("AUTHENTICATE +");
		}

		const result = await this.awaitSASLResult(8000);
		this.didAuthenticateSASL = result.ok;
		this.listener.onSaslResult?.(result.ok, result.reason);
	}

	// ─── Continuation helpers ───────────────────────────────────────────

	private awaitCapLS(timeoutMs: number): Promise<Set<string>> {
		return this.race(timeoutMs, resolve => { this.capLSResolver = resolve; }, this.capLSAccumulator);
	}

	private awaitCapReq(timeoutMs: number): Promise<boolean> {
		return this.race(timeoutMs, resolve => { this.capReqResolver = resolve; }, false);
	}

	private awaitAuthChallenge(timeoutMs: number): Promise<true> {
		return new Promise<true>(resolve => {
			let done = false;
			this.authChallengeResolver = () => { if (done) return; done = true; resolve(true); };
			setTimeout(() => { if (done) return; done = true; this.authChallengeResolver = undefined; resolve(true); }, timeoutMs);
		});
	}

	private awaitSASLResult(timeoutMs: number): Promise<{ ok: boolean; reason?: string }> {
		return new Promise(resolve => {
			let done = false;
			this.saslResultResolver = (ok, reason) => {
				if (done) return; done = true;
				resolve({ ok, reason });
			};
			setTimeout(() => {
				if (done) return; done = true;
				this.saslResultResolver = undefined;
				resolve({ ok: false, reason: "timeout" });
			}, timeoutMs);
		});
	}

	private race<T>(timeoutMs: number, install: (resolve: (v: T) => void) => void, fallback: T): Promise<T> {
		return new Promise<T>(resolve => {
			let done = false;
			const finish = (v: T) => { if (done) return; done = true; resolve(v); };
			install(finish);
			setTimeout(() => finish(fallback), timeoutMs);
		});
	}

	private transition(state: ConnectionState, reason?: string): void {
		if (this.state === state) return;
		this.state = state;
		this.listener.onState?.(state, reason);
	}

	private cleanup(): void {
		this.stopPingTimer();
		this.socket = null;
		this.buf = "";
	}

	private startPingTimer(): void {
		this.stopPingTimer();
		this.lastInboundAt = Date.now();
		this.pingTimer = setInterval(() => {
			if (this.state !== "connected") return;
			// Watchdog: if the server has gone silent past our threshold,
			// assume the link is dead and force-close.  Without this we'd
			// keep showing a stale "connected" green dot forever when the
			// kernel never delivers a close callback.
			if (Date.now() - this.lastInboundAt > IRCConnection.STALE_TIMEOUT_MS) {
				try { this.socket?.end(); } catch { /* ignore */ }
				this.onSocketClose("idle timeout — no response from server");
				return;
			}
			try { this.sendRaw(`PING :iris-${Date.now()}`); } catch { /* ignore */ }
		}, 60_000);
	}

	private stopPingTimer(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}
}
