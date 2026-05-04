// Tiny typed socket wrapper. Auto-reconnects on close, persists a
// resume token across page reloads so the server can reattach us to
// our existing IRC connections instead of spinning up a fresh session.

import type { ClientMessage, ServerMessage } from "@iris-web/shared";

const TOKEN_KEY = "iris-web:session-token";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketDiagnostic {
	status: SocketStatus;
	lastReason?: string;     // why the last close happened
	connectCount: number;    // total connect() calls since page load
	openCount: number;       // total successful WS open events
}

export interface SocketHandlers {
	onStatus(status: SocketStatus): void;
	onDiagnostic?(d: SocketDiagnostic): void;
	onMessage(msg: ServerMessage): void;
}

export class Socket {
	private ws: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	// Set by close().  Once true, the close-handler fired by an in-flight
	// WS finishing its teardown stops scheduling reconnects — without
	// this, React StrictMode (which mounts → cleans up → remounts every
	// component in dev) leaves a zombie Socket instance that keeps
	// reconnecting indefinitely, fighting the live instance over the
	// shared session token on the server.
	private closed = false;
	private connectCount = 0;
	private openCount = 0;
	private status: SocketStatus = "connecting";
	private lastReason?: string;

	constructor(private handlers: SocketHandlers) {}

	private setStatus(status: SocketStatus, reason?: string): void {
		this.status = status;
		if (reason !== undefined) this.lastReason = reason;
		this.handlers.onStatus(status);
		this.handlers.onDiagnostic?.({
			status,
			lastReason: this.lastReason,
			connectCount: this.connectCount,
			openCount: this.openCount,
		});
	}

	connect(): void {
		this.cleanup();
		this.closed = false;
		this.connectCount++;
		this.setStatus("connecting");
		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		// In dev mode, talk directly to the bun server (port injected via
		// vite `define` as `__WS_PORT__`).  Bypasses vite's WS proxy,
		// which hangs the handshake on iOS Safari/Brave over a Tailnet.
		// In prod the page and the WS share an origin (sidecar / nginx),
		// so use window.location.host as before.
		// eslint-disable-next-line @typescript-eslint/ban-ts-comment
		// @ts-ignore — __WS_PORT__ is defined via vite `define`
		const wsPort: string | undefined = typeof __WS_PORT__ === "string" ? __WS_PORT__ : undefined;
		const wsHost = (import.meta.env?.DEV && wsPort)
			? `${window.location.hostname}:${wsPort}`
			: window.location.host;
		const ws = new WebSocket(`${protocol}://${wsHost}/ws`);
		this.ws = ws;

		ws.addEventListener("open", () => {
			if (this.closed) { ws.close(); return; }
			this.openCount++;
			this.setStatus("open");
			const token = readToken();
			this.send({ type: "auth", token: token ?? undefined });
		});

		ws.addEventListener("message", ev => {
			if (this.closed) return;
			try {
				const msg = JSON.parse(ev.data) as ServerMessage;
				if (msg.type === "auth:ok") writeToken(msg.sessionId);
				this.handlers.onMessage(msg);
			} catch { /* ignore garbage */ }
		});

		const onDown = (reason: string) => {
			if (this.ws !== ws) return;        // stale handler from a previous WS
			this.ws = null;
			if (this.closed) return;           // explicit teardown — don't reconnect
			console.warn(`[iris-web] WS down (${reason}) — reconnecting in 1.5s`);
			this.setStatus("closed", reason);
			if (this.reconnectTimer == null) {
				this.reconnectTimer = window.setTimeout(() => {
					this.reconnectTimer = null;
					this.connect();
				}, 1500);
			}
		};
		ws.addEventListener("close", ev => onDown(`close code=${ev.code} reason=${ev.reason || "(none)"} clean=${ev.wasClean}`));
		ws.addEventListener("error", () => onDown("error"));
	}

	send(msg: ClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	close(): void {
		this.closed = true;
		this.cleanup();
		this.ws?.close();
		this.ws = null;
	}

	private cleanup(): void {
		if (this.reconnectTimer != null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}

export function clearSessionToken(): void {
	try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function readToken(): string | null {
	try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function writeToken(token: string): void {
	try { window.localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}
