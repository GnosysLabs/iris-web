// Stable per-nickname color.  Hashes the (lowercased) nick into a fixed
// palette so the same person reads the same color across sessions, and
// no two adjacent users share a color in practice.

const PALETTE = [
	"text-red-400",
	"text-orange-400",
	"text-amber-400",
	"text-yellow-300",
	"text-lime-400",
	"text-green-400",
	"text-emerald-400",
	"text-teal-400",
	"text-cyan-400",
	"text-sky-400",
	"text-blue-400",
	"text-indigo-400",
	"text-violet-400",
	"text-purple-400",
	"text-fuchsia-400",
	"text-pink-400",
	"text-rose-400",
] as const;

export function nickColor(nickname: string): string {
	const lower = nickname.toLowerCase();
	let hash = 5381;
	for (let i = 0; i < lower.length; i++) {
		hash = ((hash << 5) + hash + lower.charCodeAt(i)) | 0;
	}
	return PALETTE[Math.abs(hash) % PALETTE.length]!;
}
