// Typed IRC primitives — the shape the parser produces and the builder consumes.

export type IRCSource =
	| { kind: "server"; name: string }
	| { kind: "user"; nick: string; user?: string; host?: string };

export type IRCCommand =
	| { keyword: "PING"; params: string[] }
	| { keyword: "PONG"; params: string[] }
	| { keyword: "PRIVMSG"; target: string; text: string }
	| { keyword: "NOTICE"; target: string; text: string }
	// `account` and `realname` are populated only when the
	// `extended-join` cap is active.  account is "*" when the
	// joiner isn't logged in to a NickServ account.
	| { keyword: "JOIN"; channels: string[]; keys?: string[]; account?: string; realname?: string }
	| { keyword: "PART"; channel: string; reason?: string }
	| { keyword: "QUIT"; reason?: string }
	| { keyword: "NICK"; nick: string }
	| { keyword: "TOPIC"; channel: string; topic?: string }
	| { keyword: "MODE"; target: string; modeString?: string; args: string[] }
	| { keyword: "KICK"; channel: string; user: string; reason?: string }
	| { keyword: "ERROR"; reason: string }
	| { keyword: "CAP"; sub: string; payload?: string; rawParams: string[] }
	| { keyword: "AUTHENTICATE"; data: string }
	| { keyword: "TAGMSG"; target: string }
	// IRCv3 BATCH — wraps a contiguous group of messages so the client
	// can treat them as one logical unit (e.g. chathistory replay).
	// `ref` is the batch ID *without* the leading +/- sign; `isStart`
	// indicates whether this is the opener or closer.
	| { keyword: "BATCH"; isStart: boolean; ref: string; batchType?: string; params: string[] }
	// IRCv3 standard-replies: machine-readable error/warning/info from
	// the server.  `command` is the originating command name (e.g.
	// "NICK"), `code` is a SCREAMING_SNAKE error code, `context` is
	// the remaining middle params (e.g. the offending nick), and
	// `description` is the trailing human text.
	| { keyword: "FAIL"; command: string; code: string; context: string[]; description: string }
	| { keyword: "WARN"; command: string; code: string; context: string[]; description: string }
	| { keyword: "NOTE"; command: string; code: string; context: string[]; description: string }
	| { keyword: "NUMERIC"; code: number; params: string[] }
	| { keyword: "UNKNOWN"; raw: string; params: string[] };

export interface IRCMessage {
	tags: Record<string, string | true>;
	source?: IRCSource;
	command: IRCCommand;
	raw: string;
}

// Numeric replies we explicitly act on.
export const Numeric = {
	RPL_WELCOME: 1,
	RPL_MYINFO: 4,
	RPL_ISUPPORT: 5,
	RPL_TOPIC: 332,
	RPL_LISTSTART: 321,
	RPL_LIST: 322,
	RPL_LISTEND: 323,
	RPL_WHOREPLY: 352,
	RPL_ENDOFWHO: 315,
	RPL_NAMREPLY: 353,
	RPL_ENDOFNAMES: 366,
	ERR_NICKNAMEINUSE: 433,
	ERR_UNKNOWNCOMMAND: 421,
	SASL_LOGGED_IN: 900,
	SASL_LOGGED_OUT: 901,
	SASL_FAILED: 904,
	SASL_FAIL: 905,
	SASL_ABORTED: 906,
	SASL_ALREADY: 907,
	SASL_MECHS: 908,
	SASL_SUCCESS: 903,
} as const;
