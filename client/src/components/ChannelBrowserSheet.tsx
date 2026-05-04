import { useEffect, useMemo, useState } from "react";
import type { ChannelDirectoryEntry, Network } from "@iris-web/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Hash, Search, Users } from "lucide-react";
import type { ChannelListing } from "@/state/store";
import { FormattedBody } from "./ChatPane";
import { parseFormatted } from "@/lib/ircFormatting";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	network: Network | null;
	listing: ChannelListing | undefined;
	onRefresh: () => void;
	onJoin: (channel: string) => void;
}

export function ChannelBrowserSheet({ open, onOpenChange, network, listing, onRefresh, onJoin }: Props) {
	const [query, setQuery] = useState("");
	const [sortDescending, setSortDescending] = useState(true);

	// Auto-fetch the first time the sheet opens for a given network if
	// we don't already have data.
	useEffect(() => {
		if (open && network && !listing) onRefresh();
	}, [open, network?.id]);

	useEffect(() => { if (!open) setQuery(""); }, [open]);

	const filtered = useMemo(() => {
		if (!listing) return [];
		const trimmed = query.trim().toLowerCase();
		const base = trimmed.length === 0
			? listing.entries
			: listing.entries.filter(e =>
				e.name.toLowerCase().includes(trimmed) ||
				e.topic.toLowerCase().includes(trimmed));
		return [...base].sort((a, b) =>
			sortDescending ? b.userCount - a.userCount : a.userCount - b.userCount);
	}, [listing, query, sortDescending]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl gap-0 p-0 overflow-hidden">
				<DialogHeader className="p-6 pb-3">
					<DialogTitle>Browse Channels</DialogTitle>
					{network && (
						<p className="text-xs text-muted-foreground">
							Channels available on {network.name}
							{listing?.updatedAt && (
								<> · updated {formatAgo(listing.updatedAt)} ago</>
							)}
						</p>
					)}
				</DialogHeader>

				<div className="flex items-center gap-2 px-6 pb-3">
					<div className="relative flex-1">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
						<Input
							placeholder="Search channels or topics"
							value={query}
							onChange={e => setQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setSortDescending(v => !v)}
						title={sortDescending ? "Most users first" : "Fewest users first"}
					>
						<Users className="h-4 w-4" />
						{sortDescending ? "Most" : "Fewest"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={onRefresh}
						disabled={listing?.loading}
					>
						{listing?.loading
							? <Loader2 className="h-4 w-4 animate-spin" />
							: <RefreshCw className="h-4 w-4" />}
					</Button>
				</div>

				{/* Plain overflow-y-auto — Radix's <ScrollArea> wraps its children
				    in a table-cell-display element that doesn't constrain width,
				    which lets long topic strings push the row past the modal
				    edge and hide the Join button. */}
				<div className="h-[400px] overflow-y-auto border-t">
					{listing?.loading && (!listing.entries || listing.entries.length === 0) ? (
						<EmptyMessage>
							<Loader2 className="h-5 w-5 animate-spin" />
							Asking the server for channels…
						</EmptyMessage>
					) : filtered.length === 0 ? (
						<EmptyMessage>
							{listing?.entries.length === 0
								? "No channels found."
								: "No matches."}
						</EmptyMessage>
					) : (
						<div className="divide-y">
							{filtered.map(entry => (
								<ChannelRow key={entry.name} entry={entry} onJoin={() => onJoin(entry.name)} />
							))}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ChannelRow({ entry, onJoin }: { entry: ChannelDirectoryEntry; onJoin: () => void }) {
	return (
		<div className="px-6 py-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors">
			<Hash className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="font-medium text-sm truncate">{entry.name.replace(/^#/, "")}</span>
					<span className="text-[11px] text-muted-foreground shrink-0">
						{entry.userCount} {entry.userCount === 1 ? "user" : "users"}
					</span>
					{entry.modes && (
						<span
							className="font-mono text-[10px] px-1.5 py-px rounded border border-border text-muted-foreground shrink-0"
							title={`Channel modes: +${entry.modes}`}
						>
							+{entry.modes}
						</span>
					)}
				</div>
				{entry.topic && (
					<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 break-words">
						<FormattedBody segments={parseFormatted(entry.topic)} />
					</p>
				)}
			</div>
			<Button size="sm" variant="secondary" onClick={onJoin} className="shrink-0">Join</Button>
		</div>
	);
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
	return (
		<div className="h-full min-h-[200px] flex items-center justify-center gap-2 text-sm text-muted-foreground p-8 text-center">
			{children}
		</div>
	);
}

function formatAgo(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	return `${Math.floor(hr / 24)}d`;
}
