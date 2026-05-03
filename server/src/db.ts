// Persistent storage for sessions, network configs, and message history.
// Uses bun:sqlite (zero deps) with the file at `./data/iris-web.sqlite`.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Buffer, BufferKind, LinkPreview, Message, NetworkId } from "@iris-web/shared";

const DB_PATH = process.env.IRISWEB_DB_PATH ?? "./data/iris-web.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
	CREATE TABLE IF NOT EXISTS sessions (
		token        TEXT PRIMARY KEY,
		created_at   INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS networks (
		id                 TEXT PRIMARY KEY,
		session_token      TEXT NOT NULL,
		hostname           TEXT NOT NULL,
		port               INTEGER NOT NULL,
		use_tls            INTEGER NOT NULL,
		nickname           TEXT NOT NULL,
		sasl_password      TEXT,
		auto_join_channels TEXT,
		FOREIGN KEY (session_token) REFERENCES sessions(token) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS buffers (
		network_id  TEXT NOT NULL,
		name        TEXT NOT NULL,
		kind        TEXT NOT NULL,
		topic       TEXT DEFAULT '',
		PRIMARY KEY (network_id, name),
		FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS messages (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		network_id   TEXT NOT NULL,
		buffer_name  TEXT NOT NULL,
		ts           INTEGER NOT NULL,
		from_nick    TEXT NOT NULL,
		text         TEXT NOT NULL,
		kind         TEXT NOT NULL,
		is_self      INTEGER DEFAULT 0,
		is_highlight INTEGER DEFAULT 0,
		client_id    TEXT NOT NULL,
		msgid        TEXT,
		FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
	);

	CREATE INDEX IF NOT EXISTS idx_messages_buffer
		ON messages(network_id, buffer_name, ts);
`);

// Defensive migrations for DBs created before a column existed.  SQLite
// can't `ADD COLUMN IF NOT EXISTS`, so just attempt and ignore the
// "duplicate column" error.
try { db.exec("ALTER TABLE networks ADD COLUMN auto_join_channels TEXT"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN msgid TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(network_id, msgid)"); } catch {}
// Defaults to 1 (auto-connect) so existing rows behave like before.
try { db.exec("ALTER TABLE networks ADD COLUMN auto_connect INTEGER NOT NULL DEFAULT 1"); } catch {}

// Link-preview cache, keyed by URL.  We refetch entries older than
// LINK_PREVIEW_TTL_MS in `fetchOrCacheLinkPreview` so previews can
// recover if a site's metadata changes.
db.exec(`
	CREATE TABLE IF NOT EXISTS link_previews (
		url           TEXT PRIMARY KEY,
		kind          TEXT NOT NULL,
		title         TEXT,
		description   TEXT,
		site_name     TEXT,
		image_url     TEXT,
		favicon       TEXT,
		fetched_at    INTEGER NOT NULL
	);
`);

// One-time data cleanup: pre-event-playback chathistory replays from
// Ergo were stored as PRIVMSGs from a synthetic `HistServ` user.  We
// now skip those at insert time, but rows from before that fix are
// still polluting buffers — purge them.
try {
	const result = db.prepare("DELETE FROM messages WHERE from_nick = ?").run("HistServ");
	if (result.changes > 0) console.log(`pruned ${result.changes} stale HistServ rows`);
} catch {}

// ─── Sessions ───────────────────────────────────────────────────────────

const insertSessionStmt = db.prepare(
	"INSERT OR IGNORE INTO sessions (token, created_at) VALUES (?, ?)"
);

export function rememberSession(token: string): void {
	insertSessionStmt.run(token, Date.now());
}

const allSessionTokensStmt = db.prepare("SELECT token FROM sessions ORDER BY created_at ASC");

export function loadAllSessionTokens(): string[] {
	return (allSessionTokensStmt.all() as { token: string }[]).map(r => r.token);
}

const dropSessionStmt = db.prepare("DELETE FROM sessions WHERE token = ?");

/// Drop a session (cascades to its networks, buffers and messages
/// thanks to FOREIGN KEY ON DELETE CASCADE).  Used for orphan cleanup
/// in single-user mode.
export function dropSession(token: string): void {
	dropSessionStmt.run(token);
}

// ─── Networks ───────────────────────────────────────────────────────────

export interface PersistedNetwork {
	id: NetworkId;
	sessionToken: string;
	hostname: string;
	port: number;
	useTLS: boolean;
	nickname: string;
	saslPassword?: string;
	autoJoinChannels: string[];
	autoConnect: boolean;
}

const insertNetworkStmt = db.prepare(`
	INSERT OR REPLACE INTO networks
		(id, session_token, hostname, port, use_tls, nickname, sasl_password, auto_join_channels, auto_connect)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveNetwork(net: PersistedNetwork): void {
	insertNetworkStmt.run(
		net.id, net.sessionToken, net.hostname, net.port,
		net.useTLS ? 1 : 0, net.nickname, net.saslPassword ?? null,
		JSON.stringify(net.autoJoinChannels ?? []),
		net.autoConnect ? 1 : 0,
	);
}

const deleteNetworkStmt = db.prepare("DELETE FROM networks WHERE id = ?");
export function deleteNetwork(id: NetworkId): void {
	deleteNetworkStmt.run(id);
}

const networksForSessionStmt = db.prepare(`
	SELECT id, session_token, hostname, port, use_tls, nickname, sasl_password, auto_join_channels, auto_connect
	FROM networks WHERE session_token = ?
`);

export function loadNetworksForSession(token: string): PersistedNetwork[] {
	const rows = networksForSessionStmt.all(token) as Array<{
		id: string; session_token: string; hostname: string; port: number;
		use_tls: number; nickname: string; sasl_password: string | null;
		auto_join_channels: string | null;
		auto_connect: number | null;
	}>;
	return rows.map(r => ({
		id: r.id,
		sessionToken: r.session_token,
		hostname: r.hostname,
		port: r.port,
		useTLS: !!r.use_tls,
		nickname: r.nickname,
		saslPassword: r.sasl_password ?? undefined,
		autoJoinChannels: r.auto_join_channels
			? (() => { try { return JSON.parse(r.auto_join_channels!) as string[]; } catch { return []; } })()
			: [],
		autoConnect: r.auto_connect == null ? true : !!r.auto_connect,
	}));
}

// ─── Buffers ────────────────────────────────────────────────────────────

const upsertBufferStmt = db.prepare(`
	INSERT INTO buffers (network_id, name, kind, topic) VALUES (?, ?, ?, ?)
	ON CONFLICT(network_id, name) DO UPDATE SET kind = excluded.kind, topic = excluded.topic
`);

export function saveBuffer(networkId: NetworkId, name: string, kind: BufferKind, topic: string): void {
	upsertBufferStmt.run(networkId, name, kind, topic);
}

const deleteBufferStmt = db.prepare("DELETE FROM buffers WHERE network_id = ? AND name = ?");
export function deleteBuffer(networkId: NetworkId, name: string): void {
	deleteBufferStmt.run(networkId, name);
}

const deleteBufferMessagesStmt = db.prepare(
	"DELETE FROM messages WHERE network_id = ? AND buffer_name = ?"
);

/// Drop a buffer and all its persisted history.  Used when the user
/// closes a DM — we don't want stale messages to reappear if they
/// later message the same nick again.
export function deleteBufferAndMessages(networkId: NetworkId, name: string): void {
	deleteBufferMessagesStmt.run(networkId, name);
	deleteBufferStmt.run(networkId, name);
}

const buffersForNetworkStmt = db.prepare(
	"SELECT name, kind, topic FROM buffers WHERE network_id = ?"
);

export function loadBuffersForNetwork(networkId: NetworkId): Pick<Buffer, "name" | "kind" | "topic">[] {
	const rows = buffersForNetworkStmt.all(networkId) as Array<{
		name: string; kind: BufferKind; topic: string;
	}>;
	return rows.map(r => ({ name: r.name, kind: r.kind, topic: r.topic }));
}

// ─── Messages ───────────────────────────────────────────────────────────

const insertMessageStmt = db.prepare(`
	INSERT INTO messages
		(network_id, buffer_name, ts, from_nick, text, kind, is_self, is_highlight, client_id, msgid)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const msgidExistsStmt = db.prepare(`
	SELECT 1 FROM messages WHERE network_id = ? AND msgid = ? LIMIT 1
`);

/// Insert a message.  If `msgid` is provided AND a row with the same
/// (network_id, msgid) already exists, this is a no-op and returns
/// false — the chathistory replay path uses this for free dedup.
export function saveMessage(
	networkId: NetworkId, bufferName: string, msg: Message, msgid?: string,
): boolean {
	if (msgid) {
		const existing = msgidExistsStmt.get(networkId, msgid);
		if (existing) return false;
	}
	insertMessageStmt.run(
		networkId, bufferName, msg.timestamp, msg.from, msg.text, msg.kind,
		msg.isSelf ? 1 : 0, msg.isHighlight ? 1 : 0, msg.id, msgid ?? null,
	);
	return true;
}

const recentMessagesStmt = db.prepare(`
	SELECT client_id, ts, from_nick, text, kind, is_self, is_highlight
	FROM messages
	WHERE network_id = ? AND buffer_name = ?
	ORDER BY ts DESC LIMIT ?
`);

export function loadRecentMessages(
	networkId: NetworkId, bufferName: string, limit: number, bufferId: string,
): Message[] {
	const rows = recentMessagesStmt.all(networkId, bufferName, limit) as Array<{
		client_id: string; ts: number; from_nick: string; text: string;
		kind: Message["kind"]; is_self: number; is_highlight: number;
	}>;
	// Stmt returns newest-first; UI expects oldest-first.
	return rows.reverse().map(r => ({
		id: r.client_id,
		bufferId,
		timestamp: r.ts,
		from: r.from_nick,
		text: r.text,
		kind: r.kind,
		isSelf: !!r.is_self,
		isHighlight: !!r.is_highlight,
	}));
}

const messagesBeforeStmt = db.prepare(`
	SELECT client_id, ts, from_nick, text, kind, is_self, is_highlight
	FROM messages
	WHERE network_id = ? AND buffer_name = ? AND ts < ?
	ORDER BY ts DESC LIMIT ?
`);

export function loadMessagesBefore(
	networkId: NetworkId, bufferName: string, beforeTs: number, limit: number, bufferId: string,
): Message[] {
	const rows = messagesBeforeStmt.all(networkId, bufferName, beforeTs, limit) as Array<{
		client_id: string; ts: number; from_nick: string; text: string;
		kind: Message["kind"]; is_self: number; is_highlight: number;
	}>;
	return rows.reverse().map(r => ({
		id: r.client_id,
		bufferId,
		timestamp: r.ts,
		from: r.from_nick,
		text: r.text,
		kind: r.kind,
		isSelf: !!r.is_self,
		isHighlight: !!r.is_highlight,
	}));
}

// ─── Link preview cache ─────────────────────────────────────────────────

const insertLinkPreviewStmt = db.prepare(`
	INSERT OR REPLACE INTO link_previews
		(url, kind, title, description, site_name, image_url, favicon, fetched_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const loadLinkPreviewStmt = db.prepare(`
	SELECT kind, title, description, site_name, image_url, favicon, fetched_at
	FROM link_previews WHERE url = ?
`);

export function loadLinkPreview(url: string): { preview: LinkPreview; fetchedAt: number } | null {
	const row = loadLinkPreviewStmt.get(url) as {
		kind: LinkPreview["kind"]; title: string | null; description: string | null;
		site_name: string | null; image_url: string | null; favicon: string | null;
		fetched_at: number;
	} | undefined;
	if (!row) return null;
	return {
		preview: {
			url,
			kind: row.kind,
			title: row.title ?? undefined,
			description: row.description ?? undefined,
			siteName: row.site_name ?? undefined,
			imageUrl: row.image_url ?? undefined,
			favicon: row.favicon ?? undefined,
		},
		fetchedAt: row.fetched_at,
	};
}

export function saveLinkPreview(preview: LinkPreview): void {
	insertLinkPreviewStmt.run(
		preview.url, preview.kind,
		preview.title ?? null, preview.description ?? null,
		preview.siteName ?? null, preview.imageUrl ?? null, preview.favicon ?? null,
		Date.now(),
	);
}
