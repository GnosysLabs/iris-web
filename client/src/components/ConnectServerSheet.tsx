import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface ServerFormValues {
	hostname: string;
	port: number;
	useTLS: boolean;
	nickname: string;
	saslPassword?: string;
	autoJoinChannels: string[];
	autoConnect: boolean;
}

export interface ServerFormSeed {
	hostname?: string;
	port?: number;
	useTLS?: boolean;
	nickname?: string;
	autoJoinChannels?: string[];
	hasSaslPassword?: boolean;
	autoConnect?: boolean;
}

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode?: "create" | "edit";
	seed?: ServerFormSeed;
	onSubmit: (form: ServerFormValues) => void;
}

export function ConnectServerSheet({ open, onOpenChange, mode = "create", seed, onSubmit }: Props) {
	const [hostname, setHostname] = useState("");
	const [port, setPort] = useState("6697");
	const [useTLS, setUseTLS] = useState(true);
	const [nickname, setNickname] = useState("");
	const [saslPassword, setSaslPassword] = useState("");
	const [autoJoin, setAutoJoin] = useState("");
	const [autoConnect, setAutoConnect] = useState(true);

	// Re-seed only when the sheet TRANSITIONS to open.  The parent
	// recreates the `seed` object reference on every render (typing
	// tick, inbound messages, etc.); depending on it here would
	// stomp the user's in-progress edits a few times a second.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		if (!open) return;
		setHostname(seed?.hostname ?? "");
		setPort(seed?.port != null ? String(seed.port) : "6697");
		setUseTLS(seed?.useTLS ?? true);
		setNickname(seed?.nickname ?? "");
		setSaslPassword("");
		setAutoJoin((seed?.autoJoinChannels ?? []).join(" "));
		setAutoConnect(seed?.autoConnect ?? true);
	}, [open]);

	function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!hostname || !nickname) return;
		const channels = autoJoin
			.split(/[,\s]+/)
			.map(s => s.trim())
			.filter(Boolean)
			.map(s => s.startsWith("#") || s.startsWith("&") ? s : `#${s}`);
		onSubmit({
			hostname: hostname.trim(),
			port: Number(port) || (useTLS ? 6697 : 6667),
			useTLS,
			nickname: nickname.trim(),
			saslPassword: saslPassword || undefined,
			autoJoinChannels: channels,
			autoConnect,
		});
	}

	const isEdit = mode === "edit";
	const title = isEdit ? "Edit Server" : "Connect to Server";
	const submitLabel = isEdit ? "Save" : "Connect";
	const hasExistingPassword = isEdit && (seed?.hasSaslPassword ?? false);
	const passwordPlaceholder = isEdit
		? (hasExistingPassword ? "Leave blank to keep existing password" : "Not set — connecting anonymously")
		: "Only if your nickname is registered";
	const passwordStatus = isEdit
		? (hasExistingPassword ? "Saved" : "Not set")
		: "Optional";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="hostname">Server</Label>
						<Input id="hostname" placeholder="irc.libera.chat" value={hostname} onChange={e => setHostname(e.target.value)} autoFocus />
					</div>

					<div className="grid grid-cols-3 gap-3">
						<div className="col-span-2 space-y-2">
							<Label htmlFor="port">Port</Label>
							<Input id="port" placeholder="6697" value={port} onChange={e => setPort(e.target.value)} />
						</div>
						<div className="space-y-2">
							<Label htmlFor="tls">TLS</Label>
							<Button
								id="tls"
								type="button"
								variant={useTLS ? "default" : "outline"}
								onClick={() => setUseTLS(v => !v)}
								className="w-full"
							>{useTLS ? "On" : "Off"}</Button>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="nickname">Nickname</Label>
						<Input id="nickname" placeholder="yournick" value={nickname} onChange={e => setNickname(e.target.value)} />
					</div>

					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="sasl">NickServ Password</Label>
							<span className={cn(
								"text-[10px] uppercase tracking-wider",
								hasExistingPassword ? "text-emerald-400" : "text-muted-foreground",
							)}>
								{passwordStatus}
							</span>
						</div>
						<Input
							id="sasl"
							type="password"
							placeholder={passwordPlaceholder}
							value={saslPassword}
							onChange={e => setSaslPassword(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<div className="flex items-baseline justify-between">
							<Label htmlFor="autojoin">Auto-join Channels</Label>
							<span className="text-[10px] uppercase tracking-wider text-muted-foreground">Optional</span>
						</div>
						<Input
							id="autojoin"
							value={autoJoin}
							onChange={e => setAutoJoin(e.target.value)}
						/>
					</div>

					<label htmlFor="autoconnect" className="flex items-center justify-between gap-4 cursor-pointer">
						<div className="min-w-0">
							<Label htmlFor="autoconnect" className="font-medium cursor-pointer">Auto-connect on launch</Label>
							<p className="text-xs text-muted-foreground mt-0.5">
								Connect to this server automatically every time Iris starts.
							</p>
						</div>
						<Switch id="autoconnect" checked={autoConnect} onCheckedChange={setAutoConnect} />
					</label>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button type="submit">{submitLabel}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
