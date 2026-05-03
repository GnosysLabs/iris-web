// Global UI settings, persisted to localStorage.  Read with
// `loadSettings()` at startup; write with `saveSettings(next)` whenever
// the user toggles something.

export type Theme = "light" | "dark";

export interface Settings {
	hideJoinPartQuit: boolean;
	use24HourTime: boolean;
	sendTypingIndicators: boolean;
	theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
	// Most users don't care about presence noise — default it off.
	hideJoinPartQuit: true,
	use24HourTime: false,
	// On by default to encourage adoption — feels like Discord/Slack
	// when both ends speak the typing cap.
	sendTypingIndicators: true,
	// Default to dark — matches the project's visual identity and avoids
	// flipping the look for everyone who installed before light mode shipped.
	// (System-preference detection happens on first load in App.tsx.)
	theme: "dark",
};

const KEY = "iris-web:settings";

export function loadSettings(): Settings {
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) {
			// Brand-new user — honor their OS-level preference for first
			// paint.  Existing users keep whatever they had before.
			const prefersLight = typeof window.matchMedia === "function"
				&& window.matchMedia("(prefers-color-scheme: light)").matches;
			return { ...DEFAULT_SETTINGS, theme: prefersLight ? "light" : "dark" };
		}
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(s: Settings): void {
	try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
