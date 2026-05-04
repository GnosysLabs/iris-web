import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Moon } from "lucide-react";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	networkName: string;
	onSubmit: (reason: string) => void;
}

export function AwaySheet({ open, onOpenChange, networkName, onSubmit }: Props) {
	const [reason, setReason] = useState("Away");

	// Reset to the default each time the sheet opens.
	useEffect(() => { if (open) setReason("Away"); }, [open]);

	function submit(e?: React.FormEvent) {
		e?.preventDefault();
		onSubmit(reason.trim() || "Away");
		onOpenChange(false);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Moon className="h-4 w-4" />
						Set away on {networkName}
					</DialogTitle>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<label htmlFor="away-reason" className="text-sm font-medium">
							Away message
						</label>
						<Input
							id="away-reason"
							value={reason}
							onChange={e => setReason(e.target.value)}
							placeholder="Away"
							autoFocus
						/>
						<p className="text-xs text-muted-foreground">
							Shown to anyone who messages you while you're away.
						</p>
					</div>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit">Set away</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
