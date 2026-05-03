// IRC text formatting parser.
//
// Parses mIRC/IRCv3 formatting control codes (^B bold, ^I italic,
// ^_ underline, ^S strike, ^V reverse, ^C color, ^O reset, ^Q mono)
// in the same pass that detects http(s) URLs, so the renderer can
// apply styles to text and links uniformly without one stepping on
// the other.

export interface IRCStyles {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	mono?: boolean;
	reverse?: boolean;
	fg?: number;       // mIRC color index 0–98
	bg?: number;       // mIRC color index 0–98
}

export type FormattedSegment =
	| { kind: "text"; text: string; styles: IRCStyles }
	| { kind: "url"; url: string; styles: IRCStyles };

const CTRL = {
	BOLD: 0x02,
	ITALIC: 0x1d,
	UNDERLINE: 0x1f,
	STRIKE: 0x1e,
	MONO: 0x11,
	REVERSE: 0x16,
	COLOR: 0x03,
	HEX_COLOR: 0x04,    // some IRCv3 servers use hex color
	RESET: 0x0f,
};

const URL_REGEX = /https?:\/\/[^\s<>"'`)\x00-\x1f]+/i;

export function parseFormatted(input: string): FormattedSegment[] {
	const out: FormattedSegment[] = [];
	let styles: IRCStyles = {};
	let buffer = "";

	function flushText() {
		if (buffer.length === 0) return;
		// Tokenize URLs within the accumulated text run.
		const tokens = splitOnUrls(buffer);
		for (const tok of tokens) {
			if (tok.kind === "url") {
				out.push({ kind: "url", url: tok.value, styles: { ...styles } });
			} else if (tok.value.length > 0) {
				out.push({ kind: "text", text: tok.value, styles: { ...styles } });
			}
		}
		buffer = "";
	}

	let i = 0;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		switch (code) {
			case CTRL.BOLD:
				flushText();
				styles = { ...styles, bold: !styles.bold };
				i++; continue;
			case CTRL.ITALIC:
				flushText();
				styles = { ...styles, italic: !styles.italic };
				i++; continue;
			case CTRL.UNDERLINE:
				flushText();
				styles = { ...styles, underline: !styles.underline };
				i++; continue;
			case CTRL.STRIKE:
				flushText();
				styles = { ...styles, strike: !styles.strike };
				i++; continue;
			case CTRL.MONO:
				flushText();
				styles = { ...styles, mono: !styles.mono };
				i++; continue;
			case CTRL.REVERSE:
				flushText();
				styles = { ...styles, reverse: !styles.reverse };
				i++; continue;
			case CTRL.RESET:
				flushText();
				styles = {};
				i++; continue;
			case CTRL.COLOR: {
				flushText();
				i++;
				// Consume up to 2 fg digits, optional comma + up to 2 bg digits.
				const { fg, bg, consumed } = readColorSpec(input, i);
				i += consumed;
				if (fg === undefined && bg === undefined) {
					// Bare ^C clears colors.
					styles = { ...styles, fg: undefined, bg: undefined };
				} else {
					styles = {
						...styles,
						...(fg !== undefined ? { fg } : {}),
						...(bg !== undefined ? { bg } : {}),
					};
				}
				continue;
			}
			case CTRL.HEX_COLOR: {
				// ^D RRGGBB[,RRGGBB] — uncommon, just skip the bytes
				flushText();
				i++;
				const skip = readHexColorBytes(input, i);
				i += skip;
				continue;
			}
		}
		buffer += input[i];
		i++;
	}
	flushText();
	return out;
}

function readColorSpec(input: string, start: number): { fg?: number; bg?: number; consumed: number } {
	let i = start;
	let fgDigits = "";
	while (fgDigits.length < 2 && i < input.length && input[i]! >= "0" && input[i]! <= "9") {
		fgDigits += input[i]; i++;
	}
	let bgDigits = "";
	if (fgDigits.length > 0 && input[i] === "," && /[0-9]/.test(input[i + 1] ?? "")) {
		i++; // consume comma
		while (bgDigits.length < 2 && i < input.length && input[i]! >= "0" && input[i]! <= "9") {
			bgDigits += input[i]; i++;
		}
	}
	return {
		fg: fgDigits.length > 0 ? Number(fgDigits) : undefined,
		bg: bgDigits.length > 0 ? Number(bgDigits) : undefined,
		consumed: i - start,
	};
}

function readHexColorBytes(input: string, start: number): number {
	let i = start;
	let consumed = 0;
	while (consumed < 6 && i < input.length && /[0-9a-f]/i.test(input[i]!)) {
		consumed++; i++;
	}
	if (input[i] === "," && /[0-9a-f]/i.test(input[i + 1] ?? "")) {
		i++;
		while (consumed < 13 && i < input.length && /[0-9a-f]/i.test(input[i]!)) {
			consumed++; i++;
		}
	}
	return i - start;
}

interface InnerToken { kind: "text" | "url"; value: string }

function splitOnUrls(text: string): InnerToken[] {
	const out: InnerToken[] = [];
	let remainder = text;
	while (remainder.length > 0) {
		const match = URL_REGEX.exec(remainder);
		if (!match) {
			out.push({ kind: "text", value: remainder });
			break;
		}
		const start = match.index;
		const url = stripTrailingPunct(match[0]);
		const end = start + url.length;
		if (start > 0) out.push({ kind: "text", value: remainder.slice(0, start) });
		out.push({ kind: "url", value: url });
		remainder = remainder.slice(end);
	}
	return out;
}

function stripTrailingPunct(url: string): string {
	let out = url;
	while (out.length > 0) {
		const last = out[out.length - 1]!;
		if (".,;:!?".includes(last)) { out = out.slice(0, -1); continue; }
		if (last === ")" && !out.includes("(")) { out = out.slice(0, -1); continue; }
		if (last === "]" && !out.includes("[")) { out = out.slice(0, -1); continue; }
		break;
	}
	return out;
}

// mIRC color palette (extended through 99).  Indices 0-15 are the
// classic mIRC palette; 16-98 are the IRCv3 extension.  99 is
// "default" and we leave it transparent.
export const MIRC_PALETTE: Record<number, string> = {
	0:  "#ffffff", 1:  "#000000", 2:  "#00007f", 3:  "#009300", 4:  "#ff0000",
	5:  "#7f0000", 6:  "#9c009c", 7:  "#fc7f00", 8:  "#ffff00", 9:  "#00fc00",
	10: "#009393", 11: "#00ffff", 12: "#0000fc", 13: "#ff00ff", 14: "#7f7f7f",
	15: "#d2d2d2",
	16: "#470000", 17: "#472100", 18: "#474700", 19: "#324700", 20: "#004700",
	21: "#00472c", 22: "#004747", 23: "#002747", 24: "#000047", 25: "#2e0047",
	26: "#470047", 27: "#47002a",
	28: "#740000", 29: "#743a00", 30: "#747400", 31: "#517400", 32: "#007400",
	33: "#007449", 34: "#007474", 35: "#004074", 36: "#000074", 37: "#4b0074",
	38: "#740074", 39: "#740045",
	40: "#b50000", 41: "#b56300", 42: "#b5b500", 43: "#7db500", 44: "#00b500",
	45: "#00b571", 46: "#00b5b5", 47: "#0063b5", 48: "#0000b5", 49: "#7500b5",
	50: "#b500b5", 51: "#b5006b",
	52: "#ff0000", 53: "#ff8c00", 54: "#ffff00", 55: "#b2ff00", 56: "#00ff00",
	57: "#00ffa0", 58: "#00ffff", 59: "#008cff", 60: "#0000ff", 61: "#a500ff",
	62: "#ff00ff", 63: "#ff0098",
	64: "#ff5959", 65: "#ffb459", 66: "#ffff71", 67: "#cfff60", 68: "#6fff6f",
	69: "#65ffc9", 70: "#6dffff", 71: "#59b4ff", 72: "#5959ff", 73: "#c459ff",
	74: "#ff66ff", 75: "#ff59bc",
	76: "#ff9c9c", 77: "#ffd39c", 78: "#ffff9c", 79: "#e2ff9c", 80: "#9cff9c",
	81: "#9cffdb", 82: "#9cffff", 83: "#9cd3ff", 84: "#9c9cff", 85: "#dc9cff",
	86: "#ff9cff", 87: "#ff94d3",
	88: "#000000", 89: "#131313", 90: "#282828", 91: "#363636", 92: "#4d4d4d",
	93: "#656565", 94: "#818181", 95: "#9f9f9f", 96: "#bcbcbc", 97: "#e2e2e2",
	98: "#ffffff",
};
