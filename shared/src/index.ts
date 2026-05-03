// WebSocket protocol — single source of truth for client ↔ server messages.
//
// Every message on the wire is a JSON object with a `type` discriminator.
// Add new messages by extending the `ClientMessage` or `ServerMessage`
// union; TypeScript narrowing then forces both sides to handle the new
// shape.

// ─── Domain types ────────────────────────────────────────────────────────

export type NetworkId = string;
export type BufferId = string;

export type BufferKind = "channel" | "query" | "console";

export interface Network {
	id: NetworkId;
	name: string;
	hostname: string;
	port: number;
	useTLS: boolean;
	nickname: string;
	connected: boolean;
	buffers: Buffer[];
	autoJoinChannels: string[];
	// True when a NickServ/SASL password is stored for this network.
	// We never echo the actual password back to the client — this flag
	// is just so the UI can show "Saved" vs "Not set" in Edit Server.
	hasSaslPassword: boolean;
	// Whether the server should auto-connect this network on app launch.
	// Default true; users can flip to false for "manual only" servers.
	autoConnect: boolean;
}

export interface Buffer {
	id: BufferId;
	networkId: NetworkId;
	name: string;            // "#channel", "alice", or the network name for console
	kind: BufferKind;
	topic?: string;
	members: Member[];
	unreadCount: number;
	highlightCount: number;
	// True when the buffer's other party is a bot — set on query buffers
	// when we know (from ISUPPORT BOT=X + WHO).  Drives the sidebar icon.
	isBot?: boolean;
}

export interface Member {
	nickname: string;
	prefixes: string;        // e.g. "@+" — concatenated mode prefixes
	account?: string;        // populated by extended-join / WHO when known
	user?: string;           // ident, populated by userhost-in-names / WHO
	host?: string;           // populated by userhost-in-names / WHO
	isBot?: boolean;         // populated when ISUPPORT BOT=X is set and member has +X
}

export interface ChannelDirectoryEntry {
	name: string;
	userCount: number;
	topic: string;
}

export type MessageKind =
	| "privmsg"
	| "notice"
	| "action"
	| "system"
	| "error"
	// Presence events from other users — surfaced as messages so the
	// client can render or hide them based on the global settings.
	| "join"
	| "part"
	| "quit"
	| "nick";

export interface Message {
	id: string;
	bufferId: BufferId;
	timestamp: number;       // ms since epoch
	from: string;
	text: string;
	kind: MessageKind;
	isHighlight?: boolean;
	isSelf?: boolean;
}

// ─── Client → server ─────────────────────────────────────────────────────

export type ClientMessage =
	| { type: "auth"; token?: string }
	| { type: "network:add"; hostname: string; port: number; useTLS: boolean; nickname: string; saslPassword?: string; autoJoinChannels: string[]; autoConnect: boolean }
	| { type: "network:edit"; networkId: NetworkId; hostname: string; port: number; useTLS: boolean; nickname: string; saslPassword?: string; autoJoinChannels: string[]; autoConnect: boolean }
	| { type: "network:remove"; networkId: NetworkId }
	| { type: "network:reconnect"; networkId: NetworkId }
	| { type: "network:disconnect"; networkId: NetworkId }
	| { type: "buffer:open"; bufferId: BufferId }
	| { type: "buffer:close"; bufferId: BufferId }
	| { type: "input"; bufferId: BufferId; text: string }
	| { type: "history:more"; bufferId: BufferId; beforeTs: number }
	| { type: "channels:list"; networkId: NetworkId }
	| { type: "typing"; bufferId: BufferId; state: "active" | "done" }
	| { type: "link:preview"; url: string };

// ─── Server → client ─────────────────────────────────────────────────────

export type ServerMessage =
	| { type: "auth:ok"; sessionId: string }
	| { type: "auth:fail"; reason: string }
	| { type: "init"; networks: Network[] }
	| { type: "network:added"; network: Network }
	| { type: "network:removed"; networkId: NetworkId }
	| { type: "network:status"; networkId: NetworkId; connected: boolean }
	| { type: "buffer:opened"; buffer: Buffer }
	| { type: "buffer:closed"; bufferId: BufferId }
	| { type: "buffer:topic"; bufferId: BufferId; topic: string }
	| { type: "buffer:members"; bufferId: BufferId; members: Member[] }
	| { type: "msg"; message: Message }
	| { type: "history"; bufferId: BufferId; messages: Message[] }
	| { type: "history:older"; bufferId: BufferId; messages: Message[]; exhausted: boolean }
	| { type: "channels:listing"; networkId: NetworkId; loading: boolean }
	| { type: "channels:result"; networkId: NetworkId; entries: ChannelDirectoryEntry[] }
	| { type: "typing"; bufferId: BufferId; nickname: string; state: "active" | "done" }
	| { type: "link:preview"; url: string; preview: LinkPreview }
	| { type: "error"; message: string };

export interface LinkPreview {
	url: string;
	kind: "image" | "site" | "none";
	title?: string;
	description?: string;
	siteName?: string;
	imageUrl?: string;
	favicon?: string;
}
