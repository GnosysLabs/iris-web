// Local mirror of server state.  Plain useReducer-style — no third-party
// store dependency.  Mutations come from inbound ServerMessages.

import type {
	Buffer, ChannelDirectoryEntry, LinkPreview, Member, Message, Network, NetworkId, BufferId, ServerMessage,
} from "@iris-web/shared";

export interface ChannelListing {
	loading: boolean;
	entries: ChannelDirectoryEntry[];
	updatedAt: number | null;
}

export interface TypingState {
	nickname: string;
	expiresAt: number;   // ms timestamp; entries past this are stale and ignored
}

export interface AppState {
	authed: boolean;
	networks: Map<NetworkId, Network>;
	messages: Map<BufferId, Message[]>;
	channelListings: Map<NetworkId, ChannelListing>;
	typing: Map<BufferId, TypingState[]>;
	// Buffers with messages the user hasn't seen yet.  Client-side only
	// — bumped when an inbound `msg` arrives for a non-active buffer,
	// cleared when the user selects that buffer.
	unread: Set<BufferId>;
	// Buffers where the server has signaled there's no more history
	// behind the oldest local message.  Used to hide the "Load older"
	// button once we've paginated to the start.
	historyExhausted: Set<BufferId>;
	// Cache of link previews by URL.  Populated as the server returns
	// `link:preview` events; the client doesn't refetch URLs whose
	// preview is already in this map.
	linkPreviews: Map<string, LinkPreview>;
	activeBufferId: BufferId | null;
	error: string | null;
}

export const initialState: AppState = {
	authed: false,
	networks: new Map(),
	messages: new Map(),
	channelListings: new Map(),
	typing: new Map(),
	unread: new Set(),
	historyExhausted: new Set(),
	linkPreviews: new Map(),
	activeBufferId: null,
	error: null,
};

const TYPING_TTL_MS = 6000;  // active expires after 6s of silence per spec

export type Action =
	| { type: "server"; msg: ServerMessage }
	| { type: "select-buffer"; bufferId: BufferId | null };

export function reduce(state: AppState, action: Action): AppState {
	if (action.type === "select-buffer") {
		const unread = new Set(state.unread);
		if (action.bufferId) unread.delete(action.bufferId);
		return { ...state, activeBufferId: action.bufferId, unread };
	}

	const msg = action.msg;
	switch (msg.type) {
		case "auth:ok":
			return { ...state, authed: true };

		case "auth:fail":
			return { ...state, authed: false, error: msg.reason };

		case "init": {
			const networks = new Map<NetworkId, Network>();
			const messages = new Map<BufferId, Message[]>();
			for (const n of msg.networks) {
				networks.set(n.id, n);
				for (const b of n.buffers) messages.set(b.id, []);
			}
			return { ...state, networks, messages };
		}

		case "network:added": {
			const networks = new Map(state.networks);
			const messages = new Map(state.messages);
			networks.set(msg.network.id, msg.network);
			for (const b of msg.network.buffers) {
				if (!messages.has(b.id)) messages.set(b.id, []);
			}
			return { ...state, networks, messages };
		}

		case "network:removed": {
			const networks = new Map(state.networks);
			const messages = new Map(state.messages);
			const removed = networks.get(msg.networkId);
			networks.delete(msg.networkId);
			if (removed) for (const b of removed.buffers) messages.delete(b.id);
			return { ...state, networks, messages };
		}

		case "network:status": {
			const net = state.networks.get(msg.networkId);
			if (!net) return state;
			const networks = new Map(state.networks);
			networks.set(net.id, {
				...net,
				connected: msg.connected,
				// Only overwrite identified when the server explicitly sent
				// it — otherwise keep whatever value we already had so a
				// status ping doesn't accidentally clear the SASL badge.
				identified: msg.identified === undefined ? net.identified : msg.identified,
			});
			return { ...state, networks };
		}

		case "buffer:opened": {
			const networks = new Map(state.networks);
			const net = networks.get(msg.buffer.networkId);
			if (net && !net.buffers.find(b => b.id === msg.buffer.id)) {
				networks.set(net.id, { ...net, buffers: [...net.buffers, msg.buffer] });
			}
			const messages = new Map(state.messages);
			if (!messages.has(msg.buffer.id)) messages.set(msg.buffer.id, []);
			// Auto-select the first non-console buffer if nothing's active yet.
			let { activeBufferId } = state;
			if (activeBufferId == null && msg.buffer.kind !== "console") {
				activeBufferId = msg.buffer.id;
			}
			return { ...state, networks, messages, activeBufferId };
		}

		case "buffer:closed": {
			const networks = new Map(state.networks);
			for (const [id, net] of networks) {
				networks.set(id, { ...net, buffers: net.buffers.filter(b => b.id !== msg.bufferId) });
			}
			const messages = new Map(state.messages);
			messages.delete(msg.bufferId);
			const unread = new Set(state.unread);
			unread.delete(msg.bufferId);
			const activeBufferId = state.activeBufferId === msg.bufferId ? null : state.activeBufferId;
			return { ...state, networks, messages, unread, activeBufferId };
		}

		case "buffer:topic":
			return updateBuffer(state, msg.bufferId, b => ({ ...b, topic: msg.topic }));

		case "buffer:members":
			return updateBuffer(state, msg.bufferId, b => ({ ...b, members: msg.members }));

		case "msg": {
			const messages = new Map(state.messages);
			const list = messages.get(msg.message.bufferId) ?? [];
			messages.set(msg.message.bufferId, [...list, msg.message].slice(-500));

			// Mark unread when the message arrives for an inactive buffer
			// AND it's actually a "human" message — presence churn (joins,
			// nick changes) and our own echo shouldn't trigger an unread dot.
			const isPresence = msg.message.kind === "join"
				|| msg.message.kind === "part"
				|| msg.message.kind === "quit"
				|| msg.message.kind === "nick";
			const isWorthNotifying = !isPresence && !msg.message.isSelf;
			let unread = state.unread;
			if (isWorthNotifying && msg.message.bufferId !== state.activeBufferId) {
				unread = new Set(state.unread);
				unread.add(msg.message.bufferId);
			}
			return { ...state, messages, unread };
		}

		case "history": {
			const messages = new Map(state.messages);
			messages.set(msg.bufferId, msg.messages);
			return { ...state, messages };
		}

		case "history:older": {
			const messages = new Map(state.messages);
			const existing = messages.get(msg.bufferId) ?? [];
			// Prepend older messages, deduping by id (server's msgid via
			// the recordMessage path or our generated client id).
			const seen = new Set(existing.map(m => m.id));
			const newOlder = msg.messages.filter(m => !seen.has(m.id));
			messages.set(msg.bufferId, [...newOlder, ...existing]);
			const historyExhausted = new Set(state.historyExhausted);
			if (msg.exhausted) historyExhausted.add(msg.bufferId);
			else historyExhausted.delete(msg.bufferId);
			return { ...state, messages, historyExhausted };
		}

		case "channels:listing": {
			const channelListings = new Map(state.channelListings);
			const existing = channelListings.get(msg.networkId);
			channelListings.set(msg.networkId, {
				loading: msg.loading,
				entries: existing?.entries ?? [],
				updatedAt: existing?.updatedAt ?? null,
			});
			return { ...state, channelListings };
		}

		case "channels:result": {
			const channelListings = new Map(state.channelListings);
			channelListings.set(msg.networkId, {
				loading: false,
				entries: msg.entries,
				updatedAt: Date.now(),
			});
			return { ...state, channelListings };
		}

		case "link:preview": {
			const linkPreviews = new Map(state.linkPreviews);
			linkPreviews.set(msg.url, msg.preview);
			return { ...state, linkPreviews };
		}

		case "typing": {
			const typing = new Map(state.typing);
			const list = (typing.get(msg.bufferId) ?? [])
				.filter(t => t.nickname.toLowerCase() !== msg.nickname.toLowerCase());
			if (msg.state === "active") {
				list.push({ nickname: msg.nickname, expiresAt: Date.now() + TYPING_TTL_MS });
			}
			typing.set(msg.bufferId, list);
			return { ...state, typing };
		}

		case "error":
			return { ...state, error: msg.message };
	}
	return state;
}

export function activeTyping(state: AppState, bufferId: BufferId | null): string[] {
	if (!bufferId) return [];
	const now = Date.now();
	return (state.typing.get(bufferId) ?? [])
		.filter(t => t.expiresAt > now)
		.map(t => t.nickname);
}

function updateBuffer(state: AppState, bufferId: BufferId, mutate: (b: Buffer) => Buffer): AppState {
	const networks = new Map(state.networks);
	for (const [id, net] of networks) {
		networks.set(id, {
			...net,
			buffers: net.buffers.map(b => b.id === bufferId ? mutate(b) : b),
		});
	}
	return { ...state, networks };
}

export function findBuffer(state: AppState, bufferId: BufferId | null): Buffer | null {
	if (!bufferId) return null;
	for (const net of state.networks.values()) {
		const b = net.buffers.find(buf => buf.id === bufferId);
		if (b) return b;
	}
	return null;
}

export function findNetworkForBuffer(state: AppState, bufferId: BufferId | null): Network | null {
	if (!bufferId) return null;
	for (const net of state.networks.values()) {
		if (net.buffers.find(b => b.id === bufferId)) return net;
	}
	return null;
}

export type { Buffer, Member, Message, Network };
