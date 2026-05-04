import type { BufferId, Network } from "@iris-web/shared";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hash, User, Bot, Megaphone, Server, MoreHorizontal, Circle, RefreshCw, Trash2, Plug, X, KeyRound, ListPlus, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
	networks: Network[];
	activeBufferId: BufferId | null;
	unread: Set<BufferId>;
	mobileOpen: boolean;
	onSelectBuffer: (id: BufferId) => void;
	onCloseBuffer: (id: BufferId) => void;
	onReconnectNetwork: (id: string) => void;
	onDisconnectNetwork: (id: string) => void;
	onEditNetwork: (id: string) => void;
	onBrowseChannels: (id: string) => void;
	onRemoveNetwork: (id: string) => void;
	onSetAway: (id: string) => void;
}

export function Sidebar({
	networks, activeBufferId, unread, mobileOpen, onSelectBuffer, onCloseBuffer,
	onReconnectNetwork, onDisconnectNetwork, onEditNetwork, onBrowseChannels, onRemoveNetwork, onSetAway,
}: Props) {
	return (
		<aside className={cn(
			// Desktop (sm+): in-flow column with fixed width.
			// Mobile: fixed overlay below the topbar (top-12 = topbar height),
			// sliding in from the left.
			"shrink-0 border-r bg-background sm:bg-muted/40 sm:dark:bg-card/30 w-64",
			"fixed top-12 bottom-0 left-0 z-30 transition-transform sm:relative sm:top-0 sm:z-auto sm:translate-x-0",
			mobileOpen ? "translate-x-0" : "-translate-x-full",
		)}>
			<ScrollArea className="h-full">
				<div className="p-2 space-y-3">
					{networks.length === 0 && (
						<p className="text-xs text-muted-foreground px-2 py-3">No networks yet.</p>
					)}
					{networks.map(net => (
						<NetworkGroup
							key={net.id}
							network={net}
							activeBufferId={activeBufferId}
							unread={unread}
							onSelectBuffer={onSelectBuffer}
							onCloseBuffer={onCloseBuffer}
							onReconnect={() => onReconnectNetwork(net.id)}
							onDisconnect={() => onDisconnectNetwork(net.id)}
							onEdit={() => onEditNetwork(net.id)}
							onBrowse={() => onBrowseChannels(net.id)}
							onRemove={() => onRemoveNetwork(net.id)}
							onSetAway={() => onSetAway(net.id)}
						/>
					))}
				</div>
			</ScrollArea>
		</aside>
	);
}

function NetworkGroup({
	network, activeBufferId, unread, onSelectBuffer, onCloseBuffer, onReconnect, onDisconnect, onEdit, onBrowse, onRemove, onSetAway,
}: {
	network: Network;
	activeBufferId: BufferId | null;
	unread: Set<BufferId>;
	onSelectBuffer: (id: BufferId) => void;
	onCloseBuffer: (id: BufferId) => void;
	onReconnect: () => void;
	onDisconnect: () => void;
	onEdit: () => void;
	onBrowse: () => void;
	onRemove: () => void;
	onSetAway: () => void;
}) {
	// Group buffers by kind so the sidebar shows Channels first, DMs
	// below, and the network's Console buffer pinned to the bottom.
	const consoleBuffers = network.buffers.filter(b => b.kind === "console");
	const channelBuffers = network.buffers
		.filter(b => b.kind === "channel")
		.sort((a, b) => a.name.localeCompare(b.name));
	const queryBuffers = network.buffers
		.filter(b => b.kind === "query")
		.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

	return (
		<div className="space-y-0.5">
			<div className="group flex items-center justify-between px-2 py-1.5">
				<div className="flex items-center gap-2 min-w-0">
					<Circle
						className={cn(
							"h-2 w-2 shrink-0",
							network.connected ? "fill-emerald-500 text-emerald-500" : "fill-destructive text-destructive",
						)}
					/>
					<span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground truncate">
						{network.name}
					</span>
				</div>
				<NetworkMenu
					network={network}
					onReconnect={onReconnect}
					onDisconnect={onDisconnect}
					onEdit={onEdit}
					onBrowse={onBrowse}
					onRemove={onRemove}
					onSetAway={onSetAway}
				/>
			</div>

			{consoleBuffers.map(buf => (
				<BufferRow
					key={buf.id}
					name={buf.name}
					kind={buf.kind}
					active={buf.id === activeBufferId}
					unread={unread.has(buf.id)}
					onClick={() => onSelectBuffer(buf.id)}
				/>
			))}

			<BufferSection title="Channels" buffers={channelBuffers}
				activeBufferId={activeBufferId} unread={unread}
				onSelectBuffer={onSelectBuffer} onCloseBuffer={onCloseBuffer} />
			<BufferSection title="Direct Messages" buffers={queryBuffers}
				activeBufferId={activeBufferId} unread={unread}
				onSelectBuffer={onSelectBuffer} onCloseBuffer={onCloseBuffer} />
		</div>
	);
}

function BufferSection({
	title, buffers, activeBufferId, unread, onSelectBuffer, onCloseBuffer,
}: {
	title: string;
	buffers: { id: BufferId; name: string; kind: "channel" | "query" | "console"; isBot?: boolean }[];
	activeBufferId: BufferId | null;
	unread: Set<BufferId>;
	onSelectBuffer: (id: BufferId) => void;
	onCloseBuffer?: (id: BufferId) => void;
}) {
	if (buffers.length === 0) return null;
	return (
		<div className="pt-1">
			<div className="text-[9px] font-bold tracking-widest uppercase text-muted-foreground/70 px-2 pb-0.5">
				{title}
			</div>
			{buffers.map(buf => (
				<BufferRow
					key={buf.id}
					name={buf.name}
					kind={buf.kind}
					isBot={buf.isBot}
					active={buf.id === activeBufferId}
					unread={unread.has(buf.id)}
					onClick={() => onSelectBuffer(buf.id)}
					onClose={onCloseBuffer ? () => onCloseBuffer(buf.id) : undefined}
				/>
			))}
		</div>
	);
}

function NetworkMenu({
	network, onReconnect, onDisconnect, onEdit, onBrowse, onRemove, onSetAway,
}: {
	network: Network;
	onReconnect: () => void;
	onDisconnect: () => void;
	onEdit: () => void;
	onBrowse: () => void;
	onRemove: () => void;
	onSetAway: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-5 w-5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 data-[state=open]:opacity-100"
					onClick={(e) => e.stopPropagation()}
				>
					<MoreHorizontal className="h-3.5 w-3.5" />
					<span className="sr-only">Server actions</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<DropdownMenuLabel className="font-normal">
					<div className="flex flex-col gap-0.5">
						<span className="text-xs font-semibold">{network.name}</span>
						<span className="text-[10px] text-muted-foreground">
							{network.connected
								? network.hasSaslPassword && !network.identified
									? `Connected · ${network.nickname} (not identified)`
									: `Connected · ${network.nickname}`
								: `Disconnected · ${network.nickname}`}
						</span>
					</div>
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onReconnect}>
					{network.connected
						? <><RefreshCw className="h-4 w-4" /> Reconnect</>
						: <><Plug className="h-4 w-4" /> Connect</>
					}
				</DropdownMenuItem>
				{network.connected && (
					<DropdownMenuItem onSelect={onDisconnect}>
						<X className="h-4 w-4" />
						Disconnect
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onSelect={onBrowse} disabled={!network.connected}>
					<ListPlus className="h-4 w-4" />
					Browse Channels
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onSetAway} disabled={!network.connected}>
					{network.isAway
						? <><Sun className="h-4 w-4" /> Mark me back</>
						: <><Moon className="h-4 w-4" /> Set away…</>
					}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onEdit}>
					<KeyRound className="h-4 w-4" />
					Edit Server &amp; NickServ
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={onRemove}
					className="text-destructive focus:text-destructive focus:bg-destructive/10"
				>
					<Trash2 className="h-4 w-4" />
					Remove Server
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// Names that are conventionally bots/services across IRC networks.
// Anything matching is shown with a bot glyph in DM rows.
const SERVICE_NAMES = new Set([
	"nickserv", "chanserv", "memoserv", "botserv",
	"operserv", "hostserv", "saslserv", "global",
]);

function bufferIcon(kind: "channel" | "query" | "console", name: string, isBot: boolean) {
	if (kind === "channel") return Hash;
	if (kind === "console") return Server;
	// query buffer: pick a glyph based on what kind of "person" it is.
	const lower = name.toLowerCase();
	if (isBot) return Bot;                              // server-asserted +B
	if (lower.includes(".")) return Megaphone;          // server-originated notice
	if (SERVICE_NAMES.has(lower)) return Bot;           // fallback name heuristic
	return User;                                        // regular human
}

function BufferRow({
	name, kind, isBot = false, active, unread, onClick, onClose,
}: {
	name: string;
	kind: "channel" | "query" | "console";
	isBot?: boolean;
	active: boolean;
	unread: boolean;
	onClick: () => void;
	onClose?: () => void;
}) {
	const Icon = bufferIcon(kind, name, isBot);
	const label = kind === "console" ? "Console" : kind === "channel" ? name.replace(/^#/, "") : name;

	return (
		<div
			className={cn(
				"group w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer",
				active
					? "bg-secondary text-foreground"
					: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
			)}
			onClick={onClick}
		>
			<Icon className="h-3.5 w-3.5 shrink-0" />
			<span className={cn("truncate flex-1", unread && !active && "text-foreground font-medium")}>
				{label}
			</span>
			{unread && !active && (
				<span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" aria-label="unread" />
			)}
			{onClose && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onClose(); }}
					// p-1 + -mr-1 widens the click target without nudging
					// the row layout — matters because the icon-only `X`
					// at h-3 was a fiddly target on hover.
					className="p-1 -mr-1 rounded text-muted-foreground hover:text-destructive hover:bg-secondary transition-opacity shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
					title={kind === "channel" ? "Leave channel" : "Close conversation"}
					aria-label={kind === "channel" ? "Leave channel" : "Close conversation"}
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}
