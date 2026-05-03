// Catalog of slash commands shown in the Composer suggestion popover.
// Order is the display order when no prefix has been typed.

export interface SlashCommand {
	name: string;          // without leading "/"
	args: string;          // hint shown after the name, e.g. "<channel>"
	description: string;   // one-line summary
	aliases?: string[];    // alt names that should match the same command
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "join",   args: "<channel>",      description: "Join a channel" },
	{ name: "part",   args: "[channel]",      description: "Leave a channel" },
	{ name: "msg",    args: "<nick> <text>",  description: "Send a private message" },
	{ name: "query",  args: "<nick>",         description: "Open a private message buffer" },
	{ name: "nick",   args: "<new-nick>",     description: "Change your nickname" },
	{ name: "me",     args: "<action>",       description: "Send a /me action message" },
	{ name: "whois",  args: "<nick>",         description: "Look up info about a user" },
	{ name: "topic",  args: "[new topic]",    description: "View or change the channel topic" },
	{ name: "list",   args: "",               description: "Browse channels on this network" },
	{ name: "away",   args: "[message]",      description: "Mark yourself away (or back if blank)" },
	{ name: "kick",   args: "<nick> [reason]",description: "Kick a user from the channel" },
	{ name: "ban",    args: "<mask>",         description: "Ban a user/mask from the channel" },
	{ name: "mode",   args: "<target> <flags>", description: "Set channel or user modes" },
	{ name: "raw",    args: "<line>",         description: "Send a raw IRC command" },
	{ name: "quit",   args: "[reason]",       description: "Disconnect from this server" },
];

export function matchSlash(input: string): SlashCommand[] {
	if (!input.startsWith("/")) return [];
	const after = input.slice(1);
	// Suggestions only fire while typing the command name itself —
	// once a space is typed the user is into argument territory.
	if (after.includes(" ")) return [];
	const lower = after.toLowerCase();
	if (lower.length === 0) return SLASH_COMMANDS;
	return SLASH_COMMANDS.filter(c =>
		c.name.startsWith(lower) ||
		c.aliases?.some(a => a.startsWith(lower)),
	);
}
