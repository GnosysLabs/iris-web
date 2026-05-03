// Global UI settings, persisted to localStorage.  Read with
// `loadSettings()` at startup; write with `saveSettings(next)` whenever
// the user toggles something.

export interface Settings {
	hideJoinPartQuit: boolean;
	use24HourTime: boolean;
	sendTypingIndicators: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	// Most users don't care about presence noise — default it off.
	hideJoinPartQuit: true,
	use24HourTime: false,
	// On by default to encourage adoption — feels like Discord/Slack
	// when both ends speak the typing cap.
	sendTypingIndicators: true,
};

const KEY = "iris-web:settings";

export function loadSettings(): Settings {
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return DEFAULT_SETTINGS;
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(s: Settings): void {
	try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
