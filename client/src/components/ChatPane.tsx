import { useEffect, useMemo, useRef, useState } from "react";
import type { Buffer, BufferId, LinkPreview, Member, Message, Network } from "@iris-web/shared";
import { parseFormatted, MIRC_PALETTE, type IRCStyles, type FormattedSegment } from "@/lib/ircFormatting";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { nickColor } from "@/lib/nickColor";
import { matchSlash, type SlashCommand } from "@/lib/slashCommands";
import { Crown, User, MessageSquare, Info, ShieldCheck, ShieldOff, Mic, MicOff, UserMinus, Ban, Moon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Settings } from "@/state/settings";

// Names that are conventionally services across IRC networks — same set
// as the sidebar uses for the bot icon.  We use this to suppress the
// "Load older messages" button on these query buffers since their
// "history" is just transactional auth/system blurbs, not real chat.
const SERVICE_NAMES = new Set([
	"nickserv", "chanserv", "memoserv", "botserv",
	"operserv", "hostserv", "saslserv", "global",
]);

function isServiceLikeQuery(buffer: Buffer): boolean {
	if (buffer.kind !== "query") return false;
	if (buffer.isBot) return true;
	const lower = buffer.name.toLowerCase();
	return lower.includes(".") || SERVICE_NAMES.has(lower);
}

export function ChatPane({
	buffer, network, messages, channelDirectory, settings, typingNicks, historyExhausted,
	linkPreviews, onSend, onLoadDirectory, onLoadMore, onTyping, onRequestLinkPreview,
}: {
	buffer: Buffer;
	network: Network;
	messages: Message[];
	channelDirectory: { entries: { name: string }[]; loading: boolean } | undefined;
	settings: Settings;
	typingNicks: string[];
	historyExhausted: boolean;
	linkPreviews: Map<string, LinkPreview>;
	onSend: (text: string) => void;
	onLoadDirectory: () => void;
	onLoadMore: () => void;
	onTyping: (state: "active" | "done") => void;
	onRequestLinkPreview: (url: string) => void;
}) {
	const showMembers = buffer.kind === "channel" && buffer.members.length > 0;

	// Channels the user could /join — directory minus the ones we're
	// already in.  Empty until Browse Channels has been opened OR until
	// the Composer auto-loads on /join entry.
	const joinedChannelNames = new Set(
		network.buffers.filter(b => b.kind === "channel").map(b => b.name.toLowerCase()),
	);
	const joinable = (channelDirectory?.entries ?? [])
		.map(e => e.name)
		.filter(n => !joinedChannelNames.has(n.toLowerCase()));

	// Memoize so the filtered array's identity is stable across renders
	// that DON'T change the source — otherwise the typing-tick re-render
	// (every 1s) would pump a new array into MessageList and trigger an
	// unwanted scroll-to-bottom.
	const visibleMessages = useMemo(
		() => settings.hideJoinPartQuit
			? messages.filter(m => m.kind !== "join" && m.kind !== "part" && m.kind !== "quit" && m.kind !== "nick")
			: messages,
		[messages, settings.hideJoinPartQuit],
	);

	return (
		<div className="h-full flex">
			<div className="flex-1 min-w-0 flex flex-col">
				<ChatHeader buffer={buffer} network={network} />
				<MessageList
					bufferId={buffer.id}
					messages={visibleMessages}
					settings={settings}
					canLoadMore={
						buffer.kind !== "console"
						&& messages.length > 0
						&& !historyExhausted
						&& !isServiceLikeQuery(buffer)
					}
					linkPreviews={linkPreviews}
					onLoadMore={onLoadMore}
					onRequestLinkPreview={onRequestLinkPreview}
				/>
				<TypingIndicator nicks={typingNicks} />
				<Composer
					onSend={onSend}
					onTyping={onTyping}
					placeholder={`Message ${buffer.kind === "console" ? "console" : buffer.name}`}
					joinableChannels={joinable}
					directoryLoading={channelDirectory?.loading ?? false}
					onLoadDirectory={onLoadDirectory}
					memberNicks={buffer.kind === "channel" ? buffer.members.map(m => m.nickname) : []}
				/>
			</div>
			{showMembers && (
				<>
					<Separator orientation="vertical" />
					<MemberList
						members={buffer.members}
						channel={buffer.name}
						myNick={network.nickname}
						onSend={onSend}
					/>
				</>
			)}
		</div>
	);
}

function ChatHeader({ buffer, network }: { buffer: Buffer; network: Network }) {
	return (
		<header className="h-12 px-4 flex items-center gap-3 border-b bg-muted/40 dark:bg-card/30">
			<div className="min-w-0">
				<div className="flex items-baseline gap-2">
					<h1 className="font-semibold text-sm tracking-tight">
						{buffer.kind === "console" ? "Console" : buffer.name}
					</h1>
					<span className="text-xs text-muted-foreground">{network.name}</span>
				</div>
				{buffer.topic && (
					<p className="text-xs text-muted-foreground truncate">{buffer.topic}</p>
				)}
			</div>
		</header>
	);
}

function MessageList({
	bufferId, messages, settings, canLoadMore, linkPreviews, onLoadMore, onRequestLinkPreview,
}: {
	bufferId: BufferId;
	messages: Message[];
	settings: Settings;
	canLoadMore: boolean;
	linkPreviews: Map<string, LinkPreview>;
	onLoadMore: () => void;
	onRequestLinkPreview: (url: string) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	// Whether to glue scroll to the bottom on new content.  Updated
	// only by user-driven scrolls (wheel/touch/keyboard) so layout
	// shifts from late-loading images don't accidentally unstick us.
	const stickRef = useRef(true);
	const lastScrollTop = useRef(0);

	function scrollToBottom() {
		const el = ref.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
		lastScrollTop.current = el.scrollTop;
	}

	function onScroll() {
		const el = ref.current;
		if (!el) return;
		// Compare against the previous scrollTop — a content-grow
		// layout shift doesn't change scrollTop and so won't toggle
		// stick, but a real user scroll up does.
		const moved = el.scrollTop !== lastScrollTop.current;
		lastScrollTop.current = el.scrollTop;
		if (!moved) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickRef.current = distanceFromBottom < 80;
	}

	// Buffer switch: pin to bottom + retry several times to catch
	// late-loading content (chathistory backfill, images, OG previews).
	useEffect(() => {
		stickRef.current = true;
		const delays = [0, 50, 150, 400, 800, 1500];
		const timers = delays.map(ms => setTimeout(() => {
			if (stickRef.current) scrollToBottom();
		}, ms));
		return () => timers.forEach(clearTimeout);
	}, [bufferId]);

	// New content in the same buffer.
	useEffect(() => {
		if (!stickRef.current) return;
		requestAnimationFrame(scrollToBottom);
	}, [messages]);

	// Re-pin whenever content height grows under us (image loaded,
	// preview card rendered, etc.) — covers any shift the timed
	// retries above missed.
	useEffect(() => {
		const inner = contentRef.current;
		if (!inner) return;
		const observer = new ResizeObserver(() => {
			if (stickRef.current) scrollToBottom();
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={ref}
			onScroll={onScroll}
			className="flex-1 overflow-y-auto"
		>
			<div ref={contentRef} className="px-4 py-3 space-y-1">
				{canLoadMore && (
					<div className="flex justify-center pb-2">
						<button
							type="button"
							onClick={onLoadMore}
							className="text-[11px] uppercase tracking-widest text-muted-foreground
							           hover:text-foreground transition-colors px-3 py-1 rounded
							           hover:bg-secondary/50"
						>
							Load older messages
						</button>
					</div>
				)}
				{messages.length === 0 && (
					<p className="text-xs text-muted-foreground italic">No messages yet.</p>
				)}
				{messages.map(m => (
					<MessageRow
						key={m.id}
						message={m}
						use24h={settings.use24HourTime}
						linkPreviews={linkPreviews}
						onRequestLinkPreview={onRequestLinkPreview}
					/>
				))}
			</div>
		</div>
	);
}

function MessageRow({
	message, use24h, linkPreviews, onRequestLinkPreview,
}: {
	message: Message;
	use24h: boolean;
	linkPreviews: Map<string, LinkPreview>;
	onRequestLinkPreview: (url: string) => void;
}) {
	const time = new Date(message.timestamp).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: !use24h,
	});

	// Parse mIRC formatting + URLs in one pass.  Used by all message
	// kinds that carry server-or-user text — system/error included
	// since MOTDs and assorted server notices contain bold/color codes.
	const segments = useMemo<FormattedSegment[]>(() => {
		return parseFormatted(message.text);
	}, [message]);
	const urls = useMemo(
		() => segments.flatMap(s => s.kind === "url" ? [s.url] : []),
		[segments],
	);

	// Kick off preview fetches for any URL we haven't seen before.
	useEffect(() => {
		for (const url of urls) {
			if (!linkPreviews.has(url)) onRequestLinkPreview(url);
		}
	}, [urls]);

	if (message.kind === "system" || message.kind === "error") {
		return (
			<div className={cn(
				"text-xs font-mono",
				message.kind === "error" ? "text-destructive" : "text-muted-foreground",
			)}>
				<span className="opacity-50 mr-2">{time}</span>
				<FormattedBody segments={segments} />
			</div>
		);
	}

	if (message.kind === "join" || message.kind === "part" || message.kind === "quit" || message.kind === "nick") {
		return (
			<div className="text-xs text-muted-foreground/70 italic">
				<span className="opacity-50 mr-2 font-mono">{time}</span>
				<span className="not-italic font-medium">{message.from}</span>{" "}
				{message.text}
			</div>
		);
	}

	const fromColor = message.isSelf ? "text-primary" : nickColor(message.from);

	if (message.kind === "action") {
		return (
			<div className="text-sm">
				<span className="text-muted-foreground mr-2 font-mono text-xs">{time}</span>
				<span className={cn("italic", fromColor)}>{message.from} </span>
				<span className="italic"><FormattedBody segments={segments} /></span>
				<LinkPreviewsBlock urls={urls} previews={linkPreviews} />
			</div>
		);
	}

	return (
		<div className={cn(
			"text-sm leading-relaxed flex gap-3 -mx-4 px-4",
			// Highlight: a soft amber accent bar on the left + matching
			// tinted background.  Subtle in dark, just-visible in light.
			message.isHighlight && "bg-amber-500/10 border-l-2 border-amber-500/70 pl-[14px]",
		)}>
			<span className="text-muted-foreground font-mono text-xs pt-0.5 shrink-0">{time}</span>
			<span className={cn("font-semibold shrink-0", fromColor)}>{message.from}</span>
			<div className="break-words min-w-0 flex-1">
				<div><FormattedBody segments={segments} /></div>
				<LinkPreviewsBlock urls={urls} previews={linkPreviews} />
			</div>
		</div>
	);
}

export function FormattedBody({ segments }: { segments: FormattedSegment[] }) {
	return (
		<>
			{segments.map((seg, i) => {
				const style = stylesToCSS(seg.styles);
				const className = stylesToClassName(seg.styles);
				if (seg.kind === "url") {
					return (
						<a
							key={i}
							href={seg.url}
							target="_blank"
							rel="noopener noreferrer nofollow"
							style={style}
							className={cn("text-primary underline underline-offset-2 hover:text-primary/80 break-all", className)}
						>{seg.url}</a>
					);
				}
				return <span key={i} style={style} className={className}>{seg.text}</span>;
			})}
		</>
	);
}

function stylesToClassName(s: IRCStyles): string {
	return cn(
		s.bold && "font-bold",
		s.italic && "italic",
		s.underline && "underline underline-offset-2",
		s.strike && "line-through",
		s.mono && "font-mono",
	);
}

function stylesToCSS(s: IRCStyles): React.CSSProperties {
	const css: React.CSSProperties = {};
	if (s.reverse) {
		// Swap fg/bg by inverting if no explicit colors set, otherwise
		// the parser-set colors already capture the user's intent and
		// we just leave them.
		if (s.fg === undefined && s.bg === undefined) {
			css.filter = "invert(1)";
		}
	}
	if (s.fg !== undefined && MIRC_PALETTE[s.fg]) css.color = MIRC_PALETTE[s.fg];
	if (s.bg !== undefined && MIRC_PALETTE[s.bg]) {
		css.backgroundColor = MIRC_PALETTE[s.bg];
		// Tighten background to the text only — without padding this
		// would butt against neighboring text awkwardly.
		css.padding = "0 2px";
		css.borderRadius = "2px";
	}
	return css;
}

function LinkPreviewsBlock({ urls, previews }: { urls: string[]; previews: Map<string, LinkPreview> }) {
	if (urls.length === 0) return null;
	// Cap to 3 previews per message so a paste of 20 URLs doesn't blow
	// up the layout — pick the first three distinct.
	const seen = new Set<string>();
	const distinct = urls.filter(u => seen.has(u) ? false : (seen.add(u), true)).slice(0, 3);
	return (
		<div className="mt-1.5 space-y-1.5">
			{distinct.map(url => {
				const preview = previews.get(url);
				if (!preview) return null;
				if (preview.kind === "image" && preview.imageUrl) {
					return (
						<a key={url} href={url} target="_blank" rel="noopener noreferrer nofollow" className="block">
							<img
								src={preview.imageUrl}
								alt=""
								loading="lazy"
								className="rounded-md border max-h-80 w-auto object-contain bg-muted/40 dark:bg-card/30"
							/>
						</a>
					);
				}
				if (preview.kind === "site" && (preview.title || preview.description || preview.imageUrl)) {
					return <SiteCard key={url} url={url} preview={preview} />;
				}
				return null;
			})}
		</div>
	);
}

function SiteCard({ url, preview }: { url: string; preview: LinkPreview }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className="flex gap-3 max-w-2xl rounded-md border bg-muted/50 hover:bg-muted/80 dark:bg-card/40 dark:hover:bg-card/70 transition-colors
			           overflow-hidden no-underline group"
		>
			{preview.imageUrl && (
				<img
					src={preview.imageUrl}
					alt=""
					loading="lazy"
					className="h-24 w-24 object-cover shrink-0 bg-muted/40 dark:bg-card/30"
				/>
			)}
			<div className={`min-w-0 py-3 pr-3 flex flex-col gap-1 ${preview.imageUrl ? "pl-0" : "pl-3"}`}>
				{preview.siteName && (
					<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						{preview.favicon && (
							<img src={preview.favicon} alt="" className="h-3 w-3 rounded-sm" />
						)}
						<span className="truncate">{preview.siteName}</span>
					</div>
				)}
				{preview.title && (
					<div className="text-sm font-medium text-foreground truncate group-hover:text-primary">
						{preview.title}
					</div>
				)}
				{preview.description && (
					<p className="text-xs text-muted-foreground line-clamp-2">{preview.description}</p>
				)}
			</div>
		</a>
	);
}

function TypingIndicator({ nicks }: { nicks: string[] }) {
	if (nicks.length === 0) return null;
	const text = nicks.length === 1
		? `${nicks[0]} is typing…`
		: nicks.length === 2
			? `${nicks[0]} and ${nicks[1]} are typing…`
			: nicks.length <= 4
				? `${nicks.slice(0, -1).join(", ")} and ${nicks[nicks.length - 1]} are typing…`
				: `${nicks.length} people are typing…`;
	return (
		<div className="px-4 h-5 text-xs text-muted-foreground italic flex items-center">
			{text}
		</div>
	);
}

// Match `/join` (case-insensitive) optionally followed by space + prefix
// — captures the prefix the user is typing for the channel name.
const JOIN_PATTERN = /^\/join(?:\s+(\S*))?$/i;

interface ComposerProps {
	onSend: (text: string) => void;
	onTyping: (state: "active" | "done") => void;
	placeholder: string;
	joinableChannels: string[];
	directoryLoading: boolean;
	onLoadDirectory: () => void;
	memberNicks: string[];
}

// Match an in-progress @mention at the cursor position.  Captures the
// `@`-trigger and the partial nick; only fires when @ is at start-of-line
// or follows whitespace (so `you@example.com` doesn't pop the picker).
const MENTION_RE = /(^|\s)@([A-Za-z0-9_\[\]\\`{}|^-]*)$/;

// Typing throttle: at most one "active" every TYPING_RATE_MS while
// composing; "done" fires TYPING_IDLE_MS after the last keystroke,
// or immediately on submit / clear.
const TYPING_RATE_MS = 3000;
const TYPING_IDLE_MS = 5000;

function Composer({ onSend, onTyping, placeholder, joinableChannels, directoryLoading, onLoadDirectory, memberNicks }: ComposerProps) {
	const [text, setText] = useState("");
	const [cursor, setCursor] = useState(0);
	const [highlight, setHighlight] = useState(0);
	// Snapshot of `text` at the moment the user hit Escape on the mention
	// popup.  Suppresses the popup until the input changes again.
	const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const lastActiveSentRef = useRef(0);
	const idleTimerRef = useRef<number | null>(null);
	const isTypingRef = useRef(false);

	function fireTypingActive() {
		const now = Date.now();
		if (now - lastActiveSentRef.current >= TYPING_RATE_MS) {
			lastActiveSentRef.current = now;
			onTyping("active");
		}
		isTypingRef.current = true;
		if (idleTimerRef.current != null) window.clearTimeout(idleTimerRef.current);
		idleTimerRef.current = window.setTimeout(() => {
			fireTypingDone();
		}, TYPING_IDLE_MS);
	}

	function fireTypingDone() {
		if (idleTimerRef.current != null) {
			window.clearTimeout(idleTimerRef.current);
			idleTimerRef.current = null;
		}
		if (isTypingRef.current) {
			isTypingRef.current = false;
			lastActiveSentRef.current = 0;
			onTyping("done");
		}
	}

	useEffect(() => () => fireTypingDone(), []);

	// Suggestion mode is derived: empty/none, slash-commands, or channels.
	const slashSuggestions: SlashCommand[] = matchSlash(text);
	const joinMatch = JOIN_PATTERN.exec(text);
	const channelMode = joinMatch !== null;
	const channelPrefix = joinMatch?.[1] ?? "";
	const channelSuggestions = channelMode
		? joinableChannels
			.filter(name => {
				const needle = channelPrefix.toLowerCase().replace(/^#/, "");
				return name.toLowerCase().replace(/^#/, "").startsWith(needle);
			})
			.slice(0, 30)
		: [];

	// Mention mode: @<partial> at the cursor position.  Suppressed if a
	// slash command or /join completion is already active.
	const beforeCursor = text.slice(0, cursor);
	const mentionMatch = MENTION_RE.exec(beforeCursor);
	const mentionPrefix = mentionMatch?.[2] ?? null;
	const mentionMode = mentionPrefix !== null
		&& !channelMode
		&& slashSuggestions.length === 0
		&& mentionDismissedFor !== text;
	const mentionSuggestions = mentionMode
		? memberNicks
			.filter(n => n.toLowerCase().startsWith(mentionPrefix.toLowerCase()))
			.slice(0, 8)
		: [];

	const showSlash = !channelMode && !mentionMode && slashSuggestions.length > 0;
	const showChannels = channelMode;
	const showMentions = mentionMode && mentionSuggestions.length > 0;

	// When the user enters /join mode and we have nothing to suggest,
	// kick off a directory load so suggestions populate without them
	// having to open Browse Channels first.
	useEffect(() => {
		if (channelMode && joinableChannels.length === 0 && !directoryLoading) {
			onLoadDirectory();
		}
	}, [channelMode]);

	useEffect(() => { setHighlight(0); }, [text]);

	function completeSlash(cmd: SlashCommand) {
		const next = cmd.args.length === 0 ? `/${cmd.name}` : `/${cmd.name} `;
		setText(next);
		inputRef.current?.focus();
	}

	function completeChannel(name: string) {
		setText(`/join ${name} `);
		inputRef.current?.focus();
	}

	function completeMention(nick: string) {
		// Replace the in-progress `@partial` token with the bare nick.
		// At line start, suffix with ":" so the message reads
		// `nick: hello` (Slack/Discord-ish, but also the IRC convention
		// for addressing someone).  Mid-line just inserts the nick.
		if (!mentionMatch) return;
		const leading = mentionMatch[1] ?? "";
		const before = text.slice(0, mentionMatch.index + leading.length);
		const after = text.slice(cursor);
		const suffix = before.length === 0 ? ": " : " ";
		const inserted = `${nick}${suffix}`;
		const next = before + inserted + after;
		setText(next);
		// Position the cursor right after the inserted text (incl. suffix).
		const nextCursor = before.length + inserted.length;
		setCursor(nextCursor);
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(nextCursor, nextCursor);
		});
	}

	function submit(e?: React.FormEvent) {
		e?.preventDefault();
		if (!text.trim()) return;
		onSend(text);
		setText("");
		fireTypingDone();
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		const items = showSlash ? slashSuggestions.length
			: showChannels ? channelSuggestions.length
			: showMentions ? mentionSuggestions.length
			: 0;
		if (items === 0) return;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlight(h => (h + 1) % items);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlight(h => (h - 1 + items) % items);
			return;
		}
		if (e.key === "Tab") {
			e.preventDefault();
			if (showSlash && slashSuggestions[highlight]) completeSlash(slashSuggestions[highlight]!);
			else if (showChannels && channelSuggestions[highlight]) completeChannel(channelSuggestions[highlight]!);
			else if (showMentions && mentionSuggestions[highlight]) completeMention(mentionSuggestions[highlight]!);
			return;
		}
		if (e.key === "Enter" && (showSlash || showMentions || (showChannels && channelSuggestions[highlight]))) {
			// Channel suggestions: Enter selects-and-submits to actually fire /join.
			if (showChannels && channelSuggestions[highlight]) {
				e.preventDefault();
				const target = channelSuggestions[highlight]!;
				onSend(`/join ${target}`);
				setText("");
				return;
			}
			if (showSlash && slashSuggestions[highlight]) {
				e.preventDefault();
				completeSlash(slashSuggestions[highlight]!);
				return;
			}
			if (showMentions && mentionSuggestions[highlight]) {
				e.preventDefault();
				completeMention(mentionSuggestions[highlight]!);
				return;
			}
		}
		if (e.key === "Escape") {
			e.preventDefault();
			if (showMentions) {
				// Dismiss the popup but leave the partial @mention in the
				// input so the user can keep editing or just send it.
				setMentionDismissedFor(text);
				setHighlight(0);
				return;
			}
			setText("");
			return;
		}
	}

	return (
		<form onSubmit={submit} className="px-4 py-3 border-t bg-muted/40 dark:bg-card/30 relative">
			{showSlash && (
				<SlashSuggestions
					commands={slashSuggestions}
					highlight={highlight}
					onPick={completeSlash}
					onHover={setHighlight}
				/>
			)}
			{showChannels && (
				<ChannelSuggestions
					channels={channelSuggestions}
					loading={directoryLoading && channelSuggestions.length === 0}
					highlight={highlight}
					onPick={(name) => { onSend(`/join ${name}`); setText(""); }}
					onHover={setHighlight}
				/>
			)}
			{showMentions && (
				<MentionSuggestions
					nicks={mentionSuggestions}
					highlight={highlight}
					onPick={completeMention}
					onHover={setHighlight}
				/>
			)}
			<Input
				ref={inputRef}
				placeholder={placeholder}
				value={text}
				onChange={e => {
					const next = e.target.value;
					setText(next);
					setCursor(e.target.selectionStart ?? next.length);
					if (next.trim().length === 0 || next.startsWith("/")) {
						fireTypingDone();
					} else {
						fireTypingActive();
					}
				}}
				onKeyUp={e => setCursor(e.currentTarget.selectionStart ?? text.length)}
				onClick={e => setCursor(e.currentTarget.selectionStart ?? text.length)}
				onKeyDown={onKeyDown}
				autoFocus
			/>
		</form>
	);
}

function MentionSuggestions({
	nicks, highlight, onPick, onHover,
}: {
	nicks: string[];
	highlight: number;
	onPick: (nick: string) => void;
	onHover: (idx: number) => void;
}) {
	return (
		<div className="absolute bottom-full left-4 right-4 mb-2 max-h-64 overflow-auto
		                bg-popover text-popover-foreground rounded-md border shadow-md py-1 z-10">
			{nicks.map((nick, i) => (
				<button
					key={nick}
					type="button"
					onMouseEnter={() => onHover(i)}
					onMouseDown={(e) => { e.preventDefault(); onPick(nick); }}
					className={cn(
						"w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 cursor-pointer",
						i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
					)}
				>
					<User className="h-3.5 w-3.5 text-muted-foreground" />
					<span className={nickColor(nick)}>{nick}</span>
				</button>
			))}
		</div>
	);
}

function SlashSuggestions({
	commands, highlight, onPick, onHover,
}: {
	commands: SlashCommand[];
	highlight: number;
	onPick: (cmd: SlashCommand) => void;
	onHover: (idx: number) => void;
}) {
	return (
		<div className="absolute bottom-full left-4 right-4 mb-2 max-h-80 overflow-auto
		                bg-popover text-popover-foreground rounded-md border shadow-md py-1 z-10">
			{commands.map((cmd, i) => (
				<button
					key={cmd.name}
					type="button"
					onMouseEnter={() => onHover(i)}
					onMouseDown={(e) => { e.preventDefault(); onPick(cmd); }}
					className={cn(
						"w-full text-left px-3 py-1.5 text-sm flex items-baseline gap-2 cursor-pointer",
						i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
					)}
				>
					<span className="font-mono font-semibold">/{cmd.name}</span>
					{cmd.args && (
						<span className="font-mono text-xs text-muted-foreground">{cmd.args}</span>
					)}
					<span className="ml-auto text-xs text-muted-foreground truncate">{cmd.description}</span>
				</button>
			))}
		</div>
	);
}

function ChannelSuggestions({
	channels, loading, highlight, onPick, onHover,
}: {
	channels: string[];
	loading: boolean;
	highlight: number;
	onPick: (name: string) => void;
	onHover: (idx: number) => void;
}) {
	if (loading) {
		return (
			<div className="absolute bottom-full left-4 right-4 mb-2 bg-popover text-popover-foreground
			                rounded-md border shadow-md px-3 py-2 z-10 text-xs text-muted-foreground italic">
				Loading channels…
			</div>
		);
	}
	if (channels.length === 0) {
		return (
			<div className="absolute bottom-full left-4 right-4 mb-2 bg-popover text-popover-foreground
			                rounded-md border shadow-md px-3 py-2 z-10 text-xs text-muted-foreground italic">
				No matching channels. Press Enter to join a new one.
			</div>
		);
	}
	return (
		<div className="absolute bottom-full left-4 right-4 mb-2 max-h-80 overflow-auto
		                bg-popover text-popover-foreground rounded-md border shadow-md py-1 z-10">
			{channels.map((name, i) => (
				<button
					key={name}
					type="button"
					onMouseEnter={() => onHover(i)}
					onMouseDown={(e) => { e.preventDefault(); onPick(name); }}
					className={cn(
						"w-full text-left px-3 py-1.5 text-sm font-mono cursor-pointer",
						i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
					)}
				>
					{name}
				</button>
			))}
		</div>
	);
}

function MemberList({
	members, channel, myNick, onSend,
}: {
	members: Member[];
	channel: string;
	myNick: string;
	onSend: (text: string) => void;
}) {
	const grouped = groupMembers(members);
	const me = members.find(m => m.nickname.toLowerCase() === myNick.toLowerCase());
	const myRank = rankOf(me?.prefixes ?? "");

	return (
		<aside className="w-48 shrink-0 bg-muted/30 dark:bg-card/20">
			<ScrollArea className="h-full">
				<div className="py-2 px-2 space-y-3">
					<div className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground px-2 py-1.5">
						{members.length} {members.length === 1 ? "member" : "members"}
					</div>
					{MEMBER_GROUPS.map(group => {
						const list = grouped[group.id];
						if (!list || list.length === 0) return null;
						return (
							<div key={group.id} className="space-y-0.5">
								<div className="flex items-center gap-1.5 px-2 pt-1">
									<span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
										{group.label}
									</span>
									<span className="text-[10px] font-semibold text-muted-foreground/60 tabular-nums">
										{list.length}
									</span>
								</div>
								{list.map(m => (
									<MemberRow
										key={m.nickname}
										member={m}
										group={group}
										channel={channel}
										isMe={m.nickname.toLowerCase() === myNick.toLowerCase()}
										myRank={myRank}
										onSend={onSend}
									/>
								))}
							</div>
						);
					})}
				</div>
			</ScrollArea>
		</aside>
	);
}

function MemberRow({
	member, group, channel, isMe, myRank, onSend,
}: {
	member: Member;
	group: MemberGroup;
	channel: string;
	isMe: boolean;
	myRank: number;
	onSend: (text: string) => void;
}) {
	const targetRank = rankOf(member.prefixes);
	// Only show the privileged actions when we're an op-or-better AND we
	// outrank the target.  Halfop (rank 2) can voice/devoice/kick lower
	// ranks but not op/deop; only ops (rank 3) and above can op/deop.
	const canVoice = myRank >= 2 && myRank > targetRank && !isMe;
	const canKick  = myRank >= 2 && myRank > targetRank && !isMe;
	const canOp    = myRank >= 3 && myRank > targetRank && !isMe;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						"w-full px-2 py-1 text-sm truncate flex items-center gap-2 hover:bg-secondary/50 rounded-sm text-left",
						member.isAway && "opacity-50",
					)}
					title={member.isAway && member.awayMessage ? `Away: ${member.awayMessage}` : undefined}
				>
					<span className={cn(
						"w-3 flex items-center justify-center shrink-0",
						group.tone,
					)}>
						{group.id === "owner" || group.id === "op"
							? <Crown className="h-3 w-3" fill="currentColor" />
							: group.id === "regular"
								? <User className="h-3 w-3" />
								: <span className="font-mono text-xs">{group.prefix ?? ""}</span>}
					</span>
					<span className="text-foreground/90 truncate">{member.nickname}</span>
					{member.isAway && <Moon className="h-3 w-3 text-muted-foreground shrink-0 ml-auto" />}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-44">
				<DropdownMenuItem onSelect={() => onSend(`/whois ${member.nickname}`)}>
					<Info className="h-4 w-4" /> Whois
				</DropdownMenuItem>
				{!isMe && (
					<DropdownMenuItem onSelect={() => onSend(`/query ${member.nickname}`)}>
						<MessageSquare className="h-4 w-4" /> Open DM
					</DropdownMenuItem>
				)}
				{(canOp || canVoice || canKick) && <DropdownMenuSeparator />}
				{canOp && (
					targetRank >= 3
						? <DropdownMenuItem onSelect={() => onSend(`/mode ${channel} -o ${member.nickname}`)}>
								<ShieldOff className="h-4 w-4" /> Take op
							</DropdownMenuItem>
						: <DropdownMenuItem onSelect={() => onSend(`/mode ${channel} +o ${member.nickname}`)}>
								<ShieldCheck className="h-4 w-4" /> Give op
							</DropdownMenuItem>
				)}
				{canVoice && (
					targetRank >= 1
						? <DropdownMenuItem onSelect={() => onSend(`/mode ${channel} -v ${member.nickname}`)}>
								<MicOff className="h-4 w-4" /> Take voice
							</DropdownMenuItem>
						: <DropdownMenuItem onSelect={() => onSend(`/mode ${channel} +v ${member.nickname}`)}>
								<Mic className="h-4 w-4" /> Give voice
							</DropdownMenuItem>
				)}
				{canKick && (
					<>
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => onSend(`/kick ${channel} ${member.nickname}`)}
						>
							<UserMinus className="h-4 w-4" /> Kick
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => onSend(`/mode ${channel} +b ${member.nickname}!*@*`)}
						>
							<Ban className="h-4 w-4" /> Ban
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// Rank ordering for member-list permissions.  Higher = more powerful.
// Mirrors the visual MEMBER_GROUPS list but as a numeric scale so we can
// compare "I outrank target" cleanly.
function rankOf(prefixes: string): number {
	if (prefixes.includes("~")) return 5; // owner
	if (prefixes.includes("&")) return 4; // admin
	if (prefixes.includes("@")) return 3; // op
	if (prefixes.includes("%")) return 2; // halfop
	if (prefixes.includes("+")) return 1; // voiced
	return 0;
}

interface MemberGroup {
	id: "owner" | "admin" | "op" | "halfop" | "voice" | "regular";
	label: string;
	prefix: string | null;
	tone: string;
}

const MEMBER_GROUPS: MemberGroup[] = [
	{ id: "owner",   label: "Owners",    prefix: "~", tone: "text-yellow-400" },
	{ id: "admin",   label: "Admins",    prefix: "&", tone: "text-pink-400" },
	{ id: "op",      label: "Operators", prefix: "@", tone: "text-red-400" },
	{ id: "halfop",  label: "Half-Ops",  prefix: "%", tone: "text-amber-400" },
	{ id: "voice",   label: "Voiced",    prefix: "+", tone: "text-emerald-400" },
	{ id: "regular", label: "Members",   prefix: null, tone: "text-muted-foreground" },
];

function groupMembers(members: Member[]): Record<MemberGroup["id"], Member[]> {
	const buckets: Record<MemberGroup["id"], Member[]> = {
		owner: [], admin: [], op: [], halfop: [], voice: [], regular: [],
	};
	for (const m of members) {
		const top = highestPrefix(m.prefixes);
		switch (top) {
			case "~": buckets.owner.push(m); break;
			case "&": buckets.admin.push(m); break;
			case "@": buckets.op.push(m); break;
			case "%": buckets.halfop.push(m); break;
			case "+": buckets.voice.push(m); break;
			default:  buckets.regular.push(m); break;
		}
	}
	for (const key of Object.keys(buckets) as MemberGroup["id"][]) {
		buckets[key]!.sort((a, b) => a.nickname.toLowerCase().localeCompare(b.nickname.toLowerCase()));
	}
	return buckets;
}

// Pick the highest-rank prefix from the member's prefix string, in IRC's
// canonical ordering (~ > & > @ > % > +).  RPL_NAMREPLY emits prefixes
// in this order already, so the first character is what we want.
function highestPrefix(prefixes: string): string | undefined {
	const order = ["~", "&", "@", "%", "+"];
	for (const p of order) if (prefixes.includes(p)) return p;
	return undefined;
}
