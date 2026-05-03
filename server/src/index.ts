// iris-web server entry point.
//
// Holds one Session per resume token (NOT per WebSocket — page reloads
// must not lose your IRC connections).  Sessions own a set of
// NetworkSessions; their events are broadcast back over whichever WS
// the session is currently attached to.

import type { ClientMessage, ServerMessage } from "@iris-web/shared";
import { NetworkSession } from "./state/network";
import * as store from "./db";
import { getLinkPreview } from "./linkPreview";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 2002);

// Optional: when running as a packaged app (Iris.app's sidecar binary)
// the SwiftUI shell sets IRIS_WEB_CLIENT_DIR to point at the bundled
// Vite build.  We then serve those files for any non-/ws, non-/health
// route so a single port speaks both HTTP and WebSocket.  In dev this
// env is unset and Vite handles static assets — server stays API-only.
const CLIENT_DIR = process.env.IRIS_WEB_CLIENT_DIR;

// When set (Iris.app sets this), the server treats itself as serving a
// single end-user: any client that connects without a resume token
// reattaches to the existing singleton session, and orphan sessions
// from prior launches are pruned so duplicate IRC connections don't
// accumulate.  Multi-user web deployments leave this unset.
const SINGLE_USER = !!process.env.IRIS_WEB_SINGLE_USER;

interface SocketData {
	socketId: string;             // unique per WS, only used for logging
	token: string | null;         // populated after auth — points into `sessions`
}

// Keyed by resume token.  The token is opaque to the client; we send
// it back in `auth:ok` and the client stores it in localStorage so the
// next WS open can present it and reattach.
const sessions = new Map<string, Session>();

class Session {
	readonly token: string;
	readonly networks = new Map<string, NetworkSession>();
	// Multiple WS may be attached to the same session (multi-tab, mac
	// app + web app open simultaneously, etc.).  Broadcasting to all of
	// them is the right behavior — killing the previous one on every
	// new auth used to cause a thundering-herd reconnect loop, because
	// each tab's 1.5s reconnect timer would keep racing the other.
	private sockets = new Set<Bun.ServerWebSocket<SocketData>>();

	constructor(token: string) { this.token = token; }

	attach(socket: Bun.ServerWebSocket<SocketData>): void {
		this.sockets.add(socket);
	}

	detach(socket: Bun.ServerWebSocket<SocketData>): void {
		this.sockets.delete(socket);
	}

	send(msg: ServerMessage): void {
		const payload = JSON.stringify(msg);
		for (const sock of this.sockets) {
			try { sock.send(payload); } catch { /* ignore */ }
		}
	}

	exportInit(): ServerMessage {
		return {
			type: "init",
			networks: [...this.networks.values()].map(n => n.exportNetwork()),
		};
	}

	addNetwork(opts: {
		hostname: string;
		port: number;
		useTLS: boolean;
		nickname: string;
		saslPassword?: string;
		autoJoinChannels: string[];
		autoConnect: boolean;
	}): NetworkSession {
		const id = crypto.randomUUID();
		store.saveNetwork({
			id,
			sessionToken: this.token,
			hostname: opts.hostname,
			port: opts.port,
			useTLS: opts.useTLS,
			nickname: opts.nickname,
			saslPassword: opts.saslPassword,
			autoJoinChannels: opts.autoJoinChannels,
			autoConnect: opts.autoConnect,
		});
		const net = new NetworkSession(id, {
			hostname: opts.hostname,
			port: opts.port,
			useTLS: opts.useTLS,
			nickname: opts.nickname,
			saslAccount: opts.saslPassword ? opts.nickname : undefined,
			saslPassword: opts.saslPassword,
		}, msg => this.send(msg), { autoJoinChannels: opts.autoJoinChannels, autoConnect: opts.autoConnect });
		this.networks.set(id, net);
		this.send({ type: "network:added", network: net.exportNetwork() });
		// Always connect on first add — the user just clicked Connect.
		net.start();
		return net;
	}

	/// Hydrate a network from disk on server startup.  Same as addNetwork
	/// minus the persistence call (we just loaded it FROM the DB) and the
	/// `network:added` broadcast (no client is attached yet).
	hydrateNetwork(persisted: store.PersistedNetwork): NetworkSession {
		const net = new NetworkSession(persisted.id, {
			hostname: persisted.hostname,
			port: persisted.port,
			useTLS: persisted.useTLS,
			nickname: persisted.nickname,
			saslAccount: persisted.saslPassword ? persisted.nickname : undefined,
			saslPassword: persisted.saslPassword,
		}, msg => this.send(msg), { autoJoinChannels: persisted.autoJoinChannels, autoConnect: persisted.autoConnect });
		this.networks.set(persisted.id, net);
		// Only auto-connect on launch when the user opted in.
		if (persisted.autoConnect) net.start();
		return net;
	}

	removeNetwork(id: string): void {
		const net = this.networks.get(id);
		if (!net) return;
		net.stop();
		store.deleteNetwork(id);
		this.networks.delete(id);
		this.send({ type: "network:removed", networkId: id });
	}

	/// Replace an existing network's connection details and reconnect.
	/// We tear down the old IRCConnection (so the new SASL creds take
	/// effect on the next CAP negotiation) but keep the buffer/history
	/// rows because they belong to the same `networks.id` row.
	editNetwork(id: string, opts: {
		hostname: string;
		port: number;
		useTLS: boolean;
		nickname: string;
		saslPassword?: string;
		autoJoinChannels: string[];
		autoConnect: boolean;
	}): void {
		const existing = this.networks.get(id);
		if (!existing) return;
		const saslPassword = (opts.saslPassword && opts.saslPassword.length > 0)
			? opts.saslPassword
			: existing.config.saslPassword;

		store.saveNetwork({
			id,
			sessionToken: this.token,
			hostname: opts.hostname,
			port: opts.port,
			useTLS: opts.useTLS,
			nickname: opts.nickname,
			saslPassword,
			autoJoinChannels: opts.autoJoinChannels,
			autoConnect: opts.autoConnect,
		});

		// Only tear down + reconnect when something the IRC layer
		// can't change live actually changed.  Auto-join + auto-connect
		// + nickname-without-reconnect get applied in place.
		const needsReconnect =
			existing.config.hostname !== opts.hostname
			|| existing.config.port !== opts.port
			|| existing.config.useTLS !== opts.useTLS
			|| (existing.config.saslPassword ?? "") !== (saslPassword ?? "");

		if (!needsReconnect) {
			existing.autoJoinChannels = opts.autoJoinChannels;
			existing.autoConnect = opts.autoConnect;
			// /NICK works live — change without dropping the session.
			if (existing.conn.nickname.toLowerCase() !== opts.nickname.toLowerCase()) {
				try { existing.conn.sendRaw(`NICK ${opts.nickname}`); } catch { /* ignore */ }
			}
			this.send({ type: "network:added", network: existing.exportNetwork() });
			return;
		}

		// Connection-affecting change — full restart.
		existing.stop();
		const net = new NetworkSession(id, {
			hostname: opts.hostname,
			port: opts.port,
			useTLS: opts.useTLS,
			nickname: opts.nickname,
			saslAccount: saslPassword ? opts.nickname : undefined,
			saslPassword,
		}, msg => this.send(msg), { autoJoinChannels: opts.autoJoinChannels, autoConnect: opts.autoConnect });
		this.networks.set(id, net);
		this.send({ type: "network:added", network: net.exportNetwork() });
		net.start();
	}

	handleInput(bufferId: string, text: string): void {
		for (const net of this.networks.values()) {
			if (net.buffers.has(bufferId)) {
				net.sendUserInput(bufferId, text);
				return;
			}
		}
	}
}

function resolveSession(token: string | null | undefined): Session {
	if (token && sessions.has(token)) return sessions.get(token)!;
	// Single-user mode: any client without a recognized token reattaches
	// to the singleton session — prevents the "open Iris.app, see no
	// servers" problem when WKWebView's localStorage is wiped between
	// launches (and prevents orphaning the session's IRC connections).
	if (SINGLE_USER && sessions.size === 1) {
		return sessions.values().next().value!;
	}
	const newToken = crypto.randomUUID();
	store.rememberSession(newToken);
	const session = new Session(newToken);
	sessions.set(newToken, session);
	return session;
}

// Hydrate previously-saved sessions + their networks on startup so a
// process restart doesn't drop your IRC connections or your history.
// Each saved network reconnects immediately; messages flow back over WS
// as soon as a client attaches with the matching resume token.
function hydrateFromDisk(): void {
	let tokens = store.loadAllSessionTokens();

	// Single-user mode (Iris.app): keep only the most recent session
	// and prune the rest.  Their networks cascade-delete with them so
	// we don't accumulate dead IRC configs across launches.
	if (SINGLE_USER && tokens.length > 1) {
		// `loadAllSessionTokens` returns them in insertion order; the
		// most recent ones are at the end.  Keep the last, drop the rest.
		const keep = tokens[tokens.length - 1]!;
		const drop = tokens.slice(0, -1);
		for (const t of drop) store.dropSession(t);
		console.log(`single-user mode: pruned ${drop.length} orphan session(s)`);
		tokens = [keep];
	}

	for (const token of tokens) {
		const session = new Session(token);
		sessions.set(token, session);
		for (const persisted of store.loadNetworksForSession(token)) {
			session.hydrateNetwork(persisted);
		}
	}
	const total = sessions.size;
	const nets = [...sessions.values()].reduce((n, s) => n + s.networks.size, 0);
	if (total > 0) {
		console.log(`hydrated ${total} session(s) with ${nets} network(s)`);
	}
}

hydrateFromDisk();

const server = Bun.serve<SocketData, never>({
	port: PORT,

	async fetch(req, server) {
		const url = new URL(req.url);
		if (url.pathname === "/health") return new Response("ok");
		if (url.pathname === "/ws") {
			const upgraded = server.upgrade(req, {
				data: { socketId: crypto.randomUUID(), token: null },
			});
			if (upgraded) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (CLIENT_DIR) {
			const served = await serveStatic(CLIENT_DIR, url.pathname);
			if (served) return served;
		}
		return new Response("iris-web server", { status: 200 });
	},

	websocket: {
		open(ws) {
			console.log(`[ws] open ${ws.data.socketId}`);
		},

		message(ws, raw) {
			let msg: ClientMessage;
			try {
				msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
			} catch {
				ws.send(JSON.stringify({ type: "error", message: "Malformed JSON." } satisfies ServerMessage));
				return;
			}

			// Auth is the *only* message valid before the socket is bound to
			// a Session.  Everything else needs a token attached first.
			if (msg.type === "auth") {
				const session = resolveSession(msg.token);
				ws.data.token = session.token;
				session.attach(ws);
				console.log(`[ws] ${ws.data.socketId} → session ${session.token.slice(0, 8)} (resumed=${msg.token === session.token})`);
				session.send({ type: "auth:ok", sessionId: session.token });
				session.send(session.exportInit());
				// Replay the message backlog for every buffer the client is
				// about to render, so a page refresh doesn't show empty rooms.
				for (const net of session.networks.values()) net.replayHistory();
				return;
			}

			const session = ws.data.token ? sessions.get(ws.data.token) : null;
			if (!session) {
				ws.send(JSON.stringify({ type: "error", message: "Not authed." } satisfies ServerMessage));
				return;
			}

			switch (msg.type) {
				case "network:add":
					session.addNetwork({
						hostname: msg.hostname,
						port: msg.port,
						useTLS: msg.useTLS,
						nickname: msg.nickname,
						saslPassword: msg.saslPassword,
						autoJoinChannels: msg.autoJoinChannels ?? [],
						autoConnect: msg.autoConnect,
					});
					break;

				case "network:edit":
					session.editNetwork(msg.networkId, {
						hostname: msg.hostname,
						port: msg.port,
						useTLS: msg.useTLS,
						nickname: msg.nickname,
						saslPassword: msg.saslPassword,
						autoJoinChannels: msg.autoJoinChannels ?? [],
						autoConnect: msg.autoConnect,
					});
					break;

				case "network:remove":
					session.removeNetwork(msg.networkId);
					break;

				case "network:reconnect": {
					const net = session.networks.get(msg.networkId);
					if (net) { net.stop(); net.start(); }
					break;
				}

				case "network:disconnect": {
					const net = session.networks.get(msg.networkId);
					if (net) net.stop();
					break;
				}

				case "input":
					session.handleInput(msg.bufferId, msg.text);
					break;

				case "channels:list": {
					const net = session.networks.get(msg.networkId);
					if (net) net.requestChannelList();
					break;
				}

				case "typing": {
					for (const net of session.networks.values()) {
						if (net.buffers.has(msg.bufferId)) {
							net.sendTyping(msg.bufferId, msg.state);
							break;
						}
					}
					break;
				}

				case "link:preview": {
					// Fetch in the background and stream the result back
					// when ready — don't block the WS message loop.
					const url = msg.url;
					getLinkPreview(url)
						.then(preview => session.send({ type: "link:preview", url, preview }))
						.catch(() => { /* preview is best-effort */ });
					break;
				}

				case "history:more": {
					for (const net of session.networks.values()) {
						const buf = net.buffers.get(msg.bufferId);
						if (!buf || buf.kind === "console") continue;
						// Respond from local DB immediately so the
						// "Load older" affordance always resolves
						// (libera doesn't return chathistory BATCHes
						// for service queries like SaslServ — without
						// the immediate response the button would never
						// dismiss).  We then fire the network request
						// in the background; if it brings genuinely new
						// older messages, those land via the BATCH
						// handler with another history:older event.
						net.serveHistoryBeforeFromDB(buf, msg.beforeTs);
						net.requestChathistoryBefore(buf.name, msg.beforeTs);
						break;
					}
					break;
				}

				case "buffer:close": {
					for (const net of session.networks.values()) {
						if (net.buffers.has(msg.bufferId)) {
							net.closeBuffer(msg.bufferId);
							break;
						}
					}
					break;
				}

				case "buffer:open":
					break;
			}
		},

		close(ws) {
			const session = ws.data.token ? sessions.get(ws.data.token) : null;
			if (session) session.detach(ws);
			console.log(`[ws] close ${ws.data.socketId} (session retained — IRC stays connected)`);
		},
	},
});

console.log(`iris-web server listening on http://localhost:${server.port}`);
console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
// Machine-readable startup line consumed by the SwiftUI shell so it
// can route the WKWebView to the right port.  Must stay on its own
// line and remain stable — search for "PORT=" prefix.
console.log(`PORT=${server.port}`);

/// Serve a file from the Vite-built client directory.  Path traversal
/// is blocked by joining + normalizing against the root and checking
/// the resolved path stays within it.  SPA fallback: any non-existent
/// path that doesn't look like a file (no extension) returns
/// index.html so React Router-style URLs would work if we ever add them.
async function serveStatic(rootDir: string, pathname: string): Promise<Response | null> {
	const safe = normalize(pathname).replace(/^[/\\]+/, "");
	const target = join(rootDir, safe);
	if (!target.startsWith(normalize(rootDir))) return null;

	const candidate = (pathname === "/" || !pathname.includes("."))
		? join(rootDir, "index.html")
		: target;

	if (!existsSync(candidate)) {
		// SPA fallback for unknown extensionless paths.
		const fallback = join(rootDir, "index.html");
		if (!pathname.includes(".") && existsSync(fallback)) {
			return new Response(Bun.file(fallback));
		}
		return null;
	}
	return new Response(Bun.file(candidate));
}
