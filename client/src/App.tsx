import { useEffect, useReducer, useRef, useState } from "react";
import type { ClientMessage } from "@iris-web/shared";
import { Socket, type SocketStatus } from "./lib/socket";
import { activeTyping, findBuffer, findNetworkForBuffer, initialState, reduce } from "./state/store";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { ConnectServerSheet } from "./components/ConnectServerSheet";
import { ChannelBrowserSheet } from "./components/ChannelBrowserSheet";
import { SettingsSheet } from "./components/SettingsSheet";
import { Button } from "@/components/ui/button";
import { Plus, MessagesSquare, Circle, Settings as SettingsIcon, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { loadSettings, saveSettings, type Settings } from "@/state/settings";

// True when the page is hosted inside Iris.app's WKWebView (set via
// the `?native=mac` query param the Swift shell appends).  Drives the
// topbar layout so traffic lights have room to overlay on the left.
const IS_NATIVE_MAC = (() => {
	if (typeof window === "undefined") return false;
	return new URLSearchParams(window.location.search).get("native") === "mac";
})();

export default function App() {
	const [state, dispatch] = useReducer(reduce, initialState);
	const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");
	const [showAddSheet, setShowAddSheet] = useState(false);
	const [editingNetworkId, setEditingNetworkId] = useState<string | null>(null);
	const [browsingNetworkId, setBrowsingNetworkId] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [settings, setSettings] = useState<Settings>(() => loadSettings());
	const [, forceTick] = useState(0);
	const socketRef = useRef<Socket | null>(null);

	// Re-render once a second so typing-indicator TTLs evict cleanly.
	useEffect(() => {
		const id = window.setInterval(() => forceTick(n => n + 1), 1000);
		return () => window.clearInterval(id);
	}, []);

	function updateSettings(next: Settings) {
		setSettings(next);
		saveSettings(next);
	}

	// Mirror the chosen theme onto <html> so Tailwind's `dark:` variant
	// (and our `.dark` CSS-variable overrides) take effect.  Runs on every
	// settings change including the initial load.
	useEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("dark", settings.theme === "dark");
	}, [settings.theme]);

	useEffect(() => {
		const sock = new Socket({
			onStatus: setSocketStatus,
			onMessage: msg => dispatch({ type: "server", msg }),
		});
		socketRef.current = sock;
		sock.connect();
		return () => sock.close();
	}, []);

	function send(msg: ClientMessage) { socketRef.current?.send(msg); }

	const activeBuffer = findBuffer(state, state.activeBufferId);
	const activeNetwork = findNetworkForBuffer(state, state.activeBufferId);
	const activeMessages = state.activeBufferId ? state.messages.get(state.activeBufferId) ?? [] : [];

	const noNetworks = state.networks.size === 0;

	return (
		<div className="h-full flex flex-col">
			<TopBar
				status={socketStatus}
				theme={settings.theme}
				onToggleTheme={() => updateSettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })}
				onAddNetwork={() => setShowAddSheet(true)}
				onOpenSettings={() => setShowSettings(true)}
			/>
			<div className="flex-1 flex min-h-0">
				<Sidebar
					networks={[...state.networks.values()]}
					activeBufferId={state.activeBufferId}
					unread={state.unread}
					onSelectBuffer={id => dispatch({ type: "select-buffer", bufferId: id })}
					onCloseBuffer={id => send({ type: "buffer:close", bufferId: id })}
					onReconnectNetwork={id => send({ type: "network:reconnect", networkId: id })}
					onDisconnectNetwork={id => send({ type: "network:disconnect", networkId: id })}
					onEditNetwork={id => setEditingNetworkId(id)}
					onBrowseChannels={id => setBrowsingNetworkId(id)}
					onRemoveNetwork={id => send({ type: "network:remove", networkId: id })}
				/>
				<main className="flex-1 min-w-0">
					{activeBuffer && activeNetwork ? (
						<ChatPane
							buffer={activeBuffer}
							network={activeNetwork}
							messages={activeMessages}
							channelDirectory={state.channelListings.get(activeNetwork.id)}
							settings={settings}
							typingNicks={activeTyping(state, activeBuffer.id)}
							historyExhausted={state.historyExhausted.has(activeBuffer.id)}
							linkPreviews={state.linkPreviews}
							onSend={text => send({ type: "input", bufferId: activeBuffer.id, text })}
							onLoadDirectory={() => send({ type: "channels:list", networkId: activeNetwork.id })}
							onLoadMore={() => {
								const oldest = activeMessages[0]?.timestamp ?? Date.now();
								send({ type: "history:more", bufferId: activeBuffer.id, beforeTs: oldest });
							}}
							onTyping={(typingState) => {
								if (!settings.sendTypingIndicators) return;
								if (activeBuffer.kind === "console") return;
								send({ type: "typing", bufferId: activeBuffer.id, state: typingState });
							}}
							onRequestLinkPreview={url => send({ type: "link:preview", url })}
						/>
					) : (
						<EmptyState
							noNetworks={noNetworks}
							onAddNetwork={() => setShowAddSheet(true)}
						/>
					)}
				</main>
			</div>

			<ConnectServerSheet
				open={showAddSheet}
				onOpenChange={setShowAddSheet}
				mode="create"
				onSubmit={(form) => {
					send({ type: "network:add", ...form });
					setShowAddSheet(false);
				}}
			/>

			<SettingsSheet
				open={showSettings}
				onOpenChange={setShowSettings}
				settings={settings}
				onChange={updateSettings}
			/>

			<ChannelBrowserSheet
				open={browsingNetworkId != null}
				onOpenChange={(o) => { if (!o) setBrowsingNetworkId(null); }}
				network={browsingNetworkId ? state.networks.get(browsingNetworkId) ?? null : null}
				listing={browsingNetworkId ? state.channelListings.get(browsingNetworkId) : undefined}
				onRefresh={() => {
					if (browsingNetworkId) send({ type: "channels:list", networkId: browsingNetworkId });
				}}
				onJoin={(channel) => {
					if (!browsingNetworkId) return;
					// Use the network's console buffer as the input target so the
					// JOIN command isn't tied to whatever channel is currently active.
					const net = state.networks.get(browsingNetworkId);
					const console = net?.buffers.find(b => b.kind === "console");
					if (console) {
						send({ type: "input", bufferId: console.id, text: `/join ${channel}` });
						setBrowsingNetworkId(null);
					}
				}}
			/>

			<ConnectServerSheet
				open={editingNetworkId != null}
				onOpenChange={(o) => { if (!o) setEditingNetworkId(null); }}
				mode="edit"
				seed={editingNetworkId
					? (() => {
						const net = state.networks.get(editingNetworkId);
						return net ? {
							hostname: net.hostname,
							port: net.port,
							useTLS: net.useTLS,
							nickname: net.nickname,
							autoJoinChannels: net.autoJoinChannels,
							hasSaslPassword: net.hasSaslPassword,
							autoConnect: net.autoConnect,
						} : undefined;
					})()
					: undefined}
				onSubmit={(form) => {
					if (!editingNetworkId) return;
					send({ type: "network:edit", networkId: editingNetworkId, ...form });
					setEditingNetworkId(null);
				}}
			/>
		</div>
	);
}

function TopBar({
	status, theme, onToggleTheme, onAddNetwork, onOpenSettings,
}: {
	status: SocketStatus;
	theme: "light" | "dark";
	onToggleTheme: () => void;
	onAddNetwork: () => void;
	onOpenSettings: () => void;
}) {
	const tone = status === "open" ? "text-emerald-500 fill-emerald-500"
		: status === "connecting" ? "text-amber-500 fill-amber-500"
		: "text-destructive fill-destructive";
	const brand = (
		<div className="flex items-baseline gap-2">
			<img src="/favicon.png" alt="" className="h-6 w-6 self-center" />
			<span className="font-display text-base font-semibold tracking-wide">Iris IRC</span>
			{!IS_NATIVE_MAC && (
				<Circle
					className={cn("h-2 w-2 self-center", tone)}
					aria-label={`socket ${status}`}
				/>
			)}
		</div>
	);
	const actions = (
		<div className="flex items-center gap-2">
			<Button size="sm" variant="outline" onClick={onAddNetwork}>
				<Plus className="h-4 w-4" />
				Connect to Server
			</Button>
			<Button
				size="icon"
				variant="ghost"
				onClick={onToggleTheme}
				title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
			>
				{theme === "dark"
					? <Sun className="h-4 w-4" />
					: <Moon className="h-4 w-4" />}
			</Button>
			<Button size="icon" variant="ghost" onClick={onOpenSettings} title="Settings">
				<SettingsIcon className="h-4 w-4" />
			</Button>
		</div>
	);
	if (IS_NATIVE_MAC) {
		// Inside Iris.app the OS draws traffic-light controls overlaying
		// the top-left of the window.  Reserve ~78px on the left so they
		// have a clean background.  The brand sits dead-center via
		// absolute positioning so it doesn't drift with action width.
		// The whole header is a drag region; controls opt out via
		// `app-no-drag`.
		return (
			<header
				className="relative h-12 flex items-center justify-end border-b bg-muted/40 dark:bg-card/30 pr-4 app-drag-region"
				style={{ paddingLeft: 78 }}
			>
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					{brand}
				</div>
				<div className="app-no-drag relative z-10">{actions}</div>
			</header>
		);
	}
	return (
		<header className="h-12 flex items-center justify-between px-4 border-b bg-muted/40 dark:bg-card/30">
			{brand}
			{actions}
		</header>
	);
}

function EmptyState({ noNetworks, onAddNetwork }: { noNetworks: boolean; onAddNetwork: () => void }) {
	return (
		<div className="h-full flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<MessagesSquare className="h-10 w-10 text-muted-foreground mx-auto" />
				<h2 className="text-lg font-semibold">
					{noNetworks ? "Not connected" : "Pick a channel"}
				</h2>
				<p className="text-sm text-muted-foreground">
					{noNetworks
						? "Connect to an IRC server to get started."
						: "Choose a channel from the sidebar to start chatting."}
				</p>
				{noNetworks && (
					<Button onClick={onAddNetwork}>
						<Plus className="h-4 w-4" />
						Connect to a Server
					</Button>
				)}
			</div>
		</div>
	);
}
