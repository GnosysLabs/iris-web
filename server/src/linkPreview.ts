// Server-side OpenGraph + image link previews.
//
// `getLinkPreview(url)` returns a cached preview if one exists and is
// fresh, otherwise fetches the URL, parses OG / Twitter card / fallback
// HTML metadata, persists it, and returns it.  Images are detected by
// extension OR by Content-Type header — we don't fetch their bodies,
// just record the URL so the client can <img> it directly.

import type { LinkPreview } from "@iris-web/shared";
import { loadLinkPreview, saveLinkPreview } from "./db";

const TTL_MS = 1000 * 60 * 60 * 24;       // 1 day cache
const FETCH_TIMEOUT_MS = 6_000;
const MAX_BYTES = 512 * 1024;             // 512 KB of HTML max

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

export async function getLinkPreview(url: string): Promise<LinkPreview> {
	const cached = loadLinkPreview(url);
	if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.preview;

	let parsed: URL;
	try { parsed = new URL(url); } catch {
		return { url, kind: "none" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { url, kind: "none" };
	}

	// SSRF basic guard: no link-local / loopback / RFC1918 / metadata.
	if (isUnsafeHost(parsed.hostname)) {
		return { url, kind: "none" };
	}

	const result = await tryFetchPreview(parsed);
	saveLinkPreview(result);
	return result;
}

async function tryFetchPreview(parsed: URL): Promise<LinkPreview> {
	const url = parsed.toString();

	// Image-by-extension shortcut: skip the HTTP HEAD if it's obviously
	// an image URL — saves a round trip.
	if (IMAGE_EXTENSIONS.test(parsed.pathname)) {
		return { url, kind: "image", imageUrl: url };
	}

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			signal: ctrl.signal,
			redirect: "follow",
			headers: {
				"user-agent": "iris-web/0.1 link-preview-bot",
				accept: "text/html,application/xhtml+xml",
			},
		});
	} catch {
		return { url, kind: "none" };
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) return { url, kind: "none" };

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.startsWith("image/")) {
		return { url, kind: "image", imageUrl: url };
	}
	if (!contentType.includes("html") && !contentType.includes("xml")) {
		return { url, kind: "none" };
	}

	// Read up to MAX_BYTES then bail — most metadata is in the <head>.
	const reader = response.body?.getReader();
	if (!reader) return { url, kind: "none" };

	let html = "";
	let bytesRead = 0;
	const decoder = new TextDecoder();
	try {
		while (bytesRead < MAX_BYTES) {
			const { value, done } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			html += decoder.decode(value, { stream: true });
			if (html.includes("</head>")) break;
		}
		try { reader.cancel(); } catch { /* ignore */ }
	} catch {
		return { url, kind: "none" };
	}

	const meta = extractMetadata(html);
	const origin = `${parsed.protocol}//${parsed.host}`;
	const absolutize = (maybe?: string) => {
		if (!maybe) return undefined;
		try { return new URL(maybe, origin).toString(); } catch { return undefined; }
	};

	const preview: LinkPreview = {
		url,
		kind: "site",
		title: meta.title,
		description: meta.description,
		siteName: meta.siteName ?? parsed.hostname,
		imageUrl: absolutize(meta.image),
		favicon: absolutize(meta.favicon ?? "/favicon.ico"),
	};
	return preview;
}

interface ExtractedMeta {
	title?: string;
	description?: string;
	siteName?: string;
	image?: string;
	favicon?: string;
}

/// Extract OpenGraph + Twitter card + plain HTML metadata.  We use a
/// small regex pass against the HEAD content rather than a full HTML
/// parser — fast enough for our needs and pulls in zero dependencies.
function extractMetadata(html: string): ExtractedMeta {
	const out: ExtractedMeta = {};

	const metaRegex = /<meta\s+([^>]+?)\/?>/gi;
	let match: RegExpExecArray | null;
	while ((match = metaRegex.exec(html)) !== null) {
		const attrs = parseAttrs(match[1]!);
		const name = (attrs["property"] || attrs["name"] || "").toLowerCase();
		const content = attrs["content"];
		if (!name || !content) continue;
		switch (name) {
			case "og:title":            out.title       = out.title ?? content; break;
			case "twitter:title":       out.title       = out.title ?? content; break;
			case "og:description":      out.description = out.description ?? content; break;
			case "twitter:description": out.description = out.description ?? content; break;
			case "description":         out.description = out.description ?? content; break;
			case "og:site_name":        out.siteName    = out.siteName ?? content; break;
			case "og:image":            out.image       = out.image ?? content; break;
			case "twitter:image":       out.image       = out.image ?? content; break;
			case "twitter:image:src":   out.image       = out.image ?? content; break;
		}
	}

	if (!out.title) {
		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		if (titleMatch) out.title = decodeEntities(titleMatch[1]!).trim();
	}

	const linkRegex = /<link\s+([^>]+?)\/?>/gi;
	while ((match = linkRegex.exec(html)) !== null) {
		const attrs = parseAttrs(match[1]!);
		const rel = (attrs["rel"] ?? "").toLowerCase();
		if (!rel.includes("icon")) continue;
		if (!out.favicon && attrs["href"]) out.favicon = attrs["href"];
	}

	if (out.title) out.title = decodeEntities(out.title).trim();
	if (out.description) out.description = decodeEntities(out.description).trim();
	return out;
}

function parseAttrs(attrText: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([a-zA-Z0-9:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attrText)) !== null) {
		const key = m[1]!.toLowerCase();
		const value = m[3] ?? m[4] ?? m[5] ?? "";
		out[key] = value;
	}
	return out;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function isUnsafeHost(host: string): boolean {
	const lower = host.toLowerCase();
	if (lower === "localhost" || lower.endsWith(".localhost")) return true;
	if (lower === "0.0.0.0" || lower === "::") return true;
	// Loopback IPv4
	if (/^127\./.test(lower)) return true;
	// IPv6 loopback / link-local
	if (lower.startsWith("[::1") || lower.startsWith("[fe80:")) return true;
	if (lower === "::1") return true;
	// RFC 1918 private ranges
	if (/^10\./.test(lower)) return true;
	if (/^192\.168\./.test(lower)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(lower)) return true;
	// Cloud metadata endpoints
	if (lower === "169.254.169.254") return true;
	return false;
}
