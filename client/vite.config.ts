import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		port: 5173,
		// Bind to all interfaces so the dev server is reachable from
		// other devices on the LAN / Tailnet (e.g. testing the mobile
		// layout from a phone via tailscale).
		host: true,
	},
	// Inject the bun dev-server port at build time so the client's
	// Socket can connect directly in dev mode.  Bypasses vite's WS
	// proxy, which hangs the handshake on iOS Safari/Brave over a
	// Tailnet — the proxy works for desktop but is unusable on iOS.
	define: {
		__WS_PORT__: JSON.stringify(process.env.IRIS_WEB_PORT ?? "2002"),
	},
});
