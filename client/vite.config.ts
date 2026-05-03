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
		proxy: {
			"/ws": {
				target: "ws://localhost:2002",
				ws: true,
				rewriteWsOrigin: true,
				// The upstream Bun server gets restarted constantly in
				// dev (bun --watch).  When that happens the proxy's
				// half-open socket logs a noisy stack trace — silence it,
				// the browser auto-reconnects.
				configure: (proxy) => {
					proxy.on("error", () => { /* swallowed */ });
				},
			},
		},
	},
});
