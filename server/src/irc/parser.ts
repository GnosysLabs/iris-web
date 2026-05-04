import type { IRCCommand, IRCMessage, IRCSource } from "./types";

// Parse one IRC wire line (no trailing CRLF) into a structured message.
// Mirrors the Iris Swift parser; handles tags, source prefix, numeric
// replies, and trailing parameters.

export function parse(raw: string): IRCMessage {
	let line = raw;
	if (line.endsWith("\r\n")) line = line.slice(0, -2);
	else if (line.endsWith("\n")) line = line.slice(0, -1);

	let cursor = 0;
	const tags: Record<string, string | true> = {};
	let source: IRCSource | undefined;

	// 1. Tags
	if (line[cursor] === "@") {
		cursor++;
		const end = line.indexOf(" ", cursor);
		const tagBlob = end === -1 ? line.slice(cursor) : line.slice(cursor, end);
		cursor = end === -1 ? line.length : end + 1;
		for (const pair of tagBlob.split(";")) {
			if (!pair) continue;
			const eq = pair.indexOf("=");
			if (eq === -1) tags[pair] = true;
			else tags[pair.slice(0, eq)] = pair.slice(eq + 1);
		}
	}

	// 2. Source
	if (line[cursor] === ":") {
		cursor++;
		const end = line.indexOf(" ", cursor);
		const blob = end === -1 ? line.slice(cursor) : line.slice(cursor, end);
		cursor = end === -1 ? line.length : end + 1;
		source = parseSource(blob);
	}

	// 3. Command + params
	const tokens = tokenize(line.slice(cursor));
	const head = tokens[0] ?? "";
	const params = tokens.slice(1);
	const command = parseCommand(head, params);

	return { tags, source, command, raw };
}

function parseSource(blob: string): IRCSource {
	const bang = blob.indexOf("!");
	if (bang === -1) {
		// Could be either a server name or a bare nick.  Servers have a `.`
		// or `:`; nicks generally don't.
		if (blob.includes(".") || blob.includes(":")) {
			return { kind: "server", name: blob };
		}
		return { kind: "user", nick: blob };
	}
	const nick = blob.slice(0, bang);
	const rest = blob.slice(bang + 1);
	const at = rest.indexOf("@");
	if (at === -1) return { kind: "user", nick, user: rest };
	return { kind: "user", nick, user: rest.slice(0, at), host: rest.slice(at + 1) };
}

function tokenize(input: string): string[] {
	const out: string[] = [];
	let i = 0;
	const n = input.length;
	while (i < n) {
		while (i < n && input[i] === " ") i++;
		if (i >= n) break;
		if (input[i] === ":") {
			out.push(input.slice(i + 1));
			break;
		}
		const next = input.indexOf(" ", i);
		if (next === -1) {
			out.push(input.slice(i));
			break;
		}
		out.push(input.slice(i, next));
		i = next + 1;
	}
	return out;
}

function parseCommand(head: string, params: string[]): IRCCommand {
	const upper = head.toUpperCase();

	if (/^[0-9]{3}$/.test(head)) {
		return { keyword: "NUMERIC", code: Number(head), params };
	}

	switch (upper) {
		case "PING":   return { keyword: "PING", params };
		case "PONG":   return { keyword: "PONG", params };

		case "PRIVMSG":
		case "NOTICE": {
			const [target, text] = [params[0] ?? "", params[1] ?? ""];
			return upper === "PRIVMSG"
				? { keyword: "PRIVMSG", target, text }
				: { keyword: "NOTICE",  target, text };
		}

		case "JOIN": {
			// Standard: JOIN <channels> [<keys>]
			// extended-join: JOIN <channel> <account> :<realname>
			// We can tell them apart by param count + shape — a 3-arg
			// JOIN with the 2nd param non-comma-separated is the
			// extended-join form (the 2nd arg there is an account
			// name, never a key list).
			const channels = (params[0] ?? "").split(",");
			if (params.length >= 3 && params[1] && !params[1].includes(",")) {
				return { keyword: "JOIN", channels, account: params[1], realname: params[2] };
			}
			return { keyword: "JOIN", channels, keys: params[1]?.split(",") };
		}
		case "PART":   return { keyword: "PART", channel: params[0] ?? "", reason: params[1] };
		case "AWAY":   return { keyword: "AWAY", message: params[0] };
		case "QUIT":   return { keyword: "QUIT", reason: params[0] };
		case "NICK":   return { keyword: "NICK", nick: params[0] ?? "" };
		case "TOPIC":  return { keyword: "TOPIC", channel: params[0] ?? "", topic: params[1] };
		case "KICK":   return { keyword: "KICK", channel: params[0] ?? "", user: params[1] ?? "", reason: params[2] };
		case "ERROR":  return { keyword: "ERROR", reason: params[0] ?? "" };

		case "MODE": {
			const target = params[0] ?? "";
			const modeString = params[1];
			const args = params.slice(2);
			return { keyword: "MODE", target, modeString, args };
		}

		case "CAP": {
			// Wire shape: `<target> <subcommand> [*] <:caps>` — find subcommand.
			let subIdx = -1;
			for (let i = 0; i < params.length; i++) {
				const p = (params[i] ?? "").toUpperCase();
				if (p === "LS" || p === "LIST" || p === "REQ" || p === "ACK" ||
				    p === "NAK" || p === "END" || p === "NEW" || p === "DEL") {
					subIdx = i;
					break;
				}
			}
			if (subIdx === -1) return { keyword: "UNKNOWN", raw: head, params };
			const sub = (params[subIdx] ?? "").toUpperCase();
			const payload = params[params.length - 1];
			return { keyword: "CAP", sub, payload, rawParams: params };
		}

		case "AUTHENTICATE":
			return { keyword: "AUTHENTICATE", data: params[0] ?? "" };

		case "TAGMSG":
			return { keyword: "TAGMSG", target: params[0] ?? "" };

		case "BATCH": {
			const first = params[0] ?? "";
			const isStart = first.startsWith("+");
			const ref = first.replace(/^[+-]/, "");
			const batchType = isStart ? params[1] : undefined;
			const batchParams = isStart ? params.slice(2) : [];
			return { keyword: "BATCH", isStart, ref, batchType, params: batchParams };
		}

		case "FAIL":
		case "WARN":
		case "NOTE": {
			// Wire shape: <command> <code> [<context>...] :<description>
			const [command = "", code = "", ...rest] = params;
			const description = rest.length > 0 ? rest[rest.length - 1]! : "";
			const context = rest.slice(0, -1);
			return { keyword: upper as "FAIL" | "WARN" | "NOTE", command, code, context, description };
		}

		default:
			return { keyword: "UNKNOWN", raw: head, params };
	}
}
