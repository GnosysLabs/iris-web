import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { Settings } from "@/state/settings";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	settings: Settings;
	onChange: (next: Settings) => void;
}

export function SettingsSheet({ open, onOpenChange, settings, onChange }: Props) {
	function patch(part: Partial<Settings>) {
		onChange({ ...settings, ...part });
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
				</DialogHeader>
				<div className="space-y-1 -mx-2">
					<Row
						label="Hide join / part / quit"
						description="Suppress 'X joined' and 'X left' lines in channels."
						checked={settings.hideJoinPartQuit}
						onCheckedChange={v => patch({ hideJoinPartQuit: v })}
					/>
					<Row
						label="24-hour timestamps"
						description="Show message times as 13:42 instead of 1:42 PM."
						checked={settings.use24HourTime}
						onCheckedChange={v => patch({ use24HourTime: v })}
					/>
					<Row
						label="Send typing indicators"
						description="Tell other users when you're typing (only on servers that support it)."
						checked={settings.sendTypingIndicators}
						onCheckedChange={v => patch({ sendTypingIndicators: v })}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Row({
	label, description, checked, onCheckedChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	onCheckedChange: (v: boolean) => void;
}) {
	const id = label.replace(/\s+/g, "-").toLowerCase();
	return (
		<label
			htmlFor={id}
			className="flex items-start justify-between gap-4 px-2 py-3 rounded-md hover:bg-secondary/40 cursor-pointer"
		>
			<div className="min-w-0">
				<Label htmlFor={id} className="font-medium cursor-pointer">{label}</Label>
				<p className="text-xs text-muted-foreground mt-0.5">{description}</p>
			</div>
			<Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
		</label>
	);
}
