// Tiny typed socket wrapper. Auto-reconnects on close, persists a
// resume token across page reloads so the server can reattach us to
// our existing IRC connections instead of spinning up a fresh session.

import type { ClientMessage, ServerMessage } from "@iris-web/shared";

const TOKEN_KEY = "iris-web:session-token";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketHandlers {
	onStatus(status: SocketStatus): void;
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

	constructor(private handlers: SocketHandlers) {}

	connect(): void {
		this.cleanup();
		this.closed = false;
		this.handlers.onStatus("connecting");
		const protocol = window.location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
		this.ws = ws;

		ws.addEventListener("open", () => {
			if (this.closed) { ws.close(); return; }
			this.handlers.onStatus("open");
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

		const onDown = () => {
			if (this.ws !== ws) return;        // stale handler from a previous WS
			this.ws = null;
			if (this.closed) return;           // explicit teardown — don't reconnect
			this.handlers.onStatus("closed");
			if (this.reconnectTimer == null) {
				this.reconnectTimer = window.setTimeout(() => {
					this.reconnectTimer = null;
					this.connect();
				}, 1500);
			}
		};
		ws.addEventListener("close", onDown);
		ws.addEventListener("error", onDown);
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
