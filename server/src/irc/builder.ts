// Build an outgoing IRC line.  Always emits the trailing parameter with
// a leading colon, since clients can't tell which params will contain
// spaces ahead of time.

export function build(parts: { command: string; params?: string[]; trailing?: string }): string {
	const head = parts.command;
	const middle = (parts.params ?? []).join(" ");
	const trailing = parts.trailing == null ? "" : ` :${parts.trailing}`;
	return middle ? `${head} ${middle}${trailing}` : `${head}${trailing}`;
}

// ─── Convenience builders ───────────────────────────────────────────────

export const cmd = {
	pass:    (password: string)        => build({ command: "PASS", trailing: password }),
	nick:    (nick: string)            => build({ command: "NICK", params: [nick] }),
	user:    (user: string, real: string) => build({ command: "USER", params: [user, "0", "*"], trailing: real }),
	join:    (channel: string, key?: string) =>
		key ? build({ command: "JOIN", params: [channel, key] })
		    : build({ command: "JOIN", params: [channel] }),
	part:    (channel: string, reason?: string) =>
		reason ? build({ command: "PART", params: [channel], trailing: reason })
		       : build({ command: "PART", params: [channel] }),
	quit:    (reason?: string)         => build({ command: "QUIT", trailing: reason ?? "iris-web" }),
	nickChange: (newNick: string)      => build({ command: "NICK", params: [newNick] }),
	privmsg: (target: string, text: string) => build({ command: "PRIVMSG", params: [target], trailing: text }),
	notice:  (target: string, text: string) => build({ command: "NOTICE", params: [target], trailing: text }),
	pong:    (token: string)           => build({ command: "PONG", trailing: token }),
	topic:   (channel: string, topic?: string) =>
		topic == null ? build({ command: "TOPIC", params: [channel] })
		              : build({ command: "TOPIC", params: [channel], trailing: topic }),
	mode:    (target: string, modeString: string, args: string[] = []) =>
		build({ command: "MODE", params: [target, modeString, ...args] }),
	whois:   (nick: string)            => build({ command: "WHOIS", params: [nick] }),
	names:   (channel: string)         => build({ command: "NAMES", params: [channel] }),
};
