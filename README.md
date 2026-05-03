# Iris IRC

A modern, self-hostable IRC client. Browser-first, with a native macOS shell built on the same code.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

## What's in the box

- **Browser-first IRC client** that looks like a 2020s chat app, not a 1998 telnet wrapper
- **Persistent connections** — close the tab, IRC stays connected; history syncs back when you return
- **One-time NickServ login** via SASL; auto-GHOST + reclaim if your nick is held
- **Server-side history** (IRCv3 chathistory) so you see what was said while you were offline
- **Live link & image previews** with OpenGraph cards
- **Typing indicators** (IRCv3 typing tag)
- **Hide join/part/quit** by default — channel reads like chat, not noise
- **Full mIRC text formatting** including the 99-color extended palette
- **Bot detection** via the actual `+B` user mode (not name guessing)
- **Auto-join channels**, **per-server NickServ**, **channel browser**, **member roles** (owners/ops/voiced/regular)
- **Dark, polished, single-purpose** — no telemetry, no spyware, MIT licensed

## Stack

| Layer    | Tech                                                      |
| -------- | --------------------------------------------------------- |
| Backend  | [Bun](https://bun.sh) + TypeScript, native WebSocket, SQLite via `bun:sqlite` |
| Frontend | React + Vite + Tailwind + shadcn/ui                       |
| Shared   | TypeScript types for the WS protocol                      |

The whole backend compiles to a **single static binary** with `bun build --compile`. No Docker required.

## Install (self-hosted)

The simplest path is the prebuilt binary + bundled client:

```bash
# Coming soon — for now, build from source (below).
curl -L https://github.com/GnosysLabs/iris-web/releases/latest/download/iris-web-linux-x64.tar.gz | tar xz
cd iris-web
./irisweb
# open http://localhost:2002 in your browser
```

For real deployment behind TLS, drop the binary next to a `Caddyfile`:

```caddy
chat.example.com {
    reverse_proxy localhost:2002
}
```

…and a systemd unit at `/etc/systemd/system/iris-web.service`:

```ini
[Unit]
Description=Iris IRC web client
After=network-online.target

[Service]
ExecStart=/opt/iris-web/irisweb
Environment=PORT=2002
Environment=IRISWEB_DB_PATH=/var/lib/iris-web/iris.sqlite
Environment=IRIS_WEB_CLIENT_DIR=/opt/iris-web/iris-web-client
Restart=always
User=iris-web
WorkingDirectory=/opt/iris-web

[Install]
WantedBy=multi-user.target
```

That's the whole deploy story.

## Build from source

```bash
git clone https://github.com/GnosysLabs/iris-web.git
cd iris-web
bun install
bun run --cwd client build
bun build --cwd server src/index.ts --compile --outfile irisweb
IRIS_WEB_CLIENT_DIR=./client/dist ./irisweb
```

## Develop

```bash
bun install
bun run dev:server   # port 2002
bun run dev:client   # vite dev server on 5173, proxies /ws to :2002
```

Open `http://localhost:5173`.

## Layout

```
iris-web/
  server/     Bun HTTP + WebSocket server.  Holds persistent IRC connections.
  client/     React SPA.  Talks WebSocket only — no IRC knowledge here.
  shared/     Protocol types for both ends.
```

## Native macOS app

A SwiftUI shell wrapping iris-web in a `WKWebView` ships separately at
[github.com/GnosysLabs/iris](https://github.com/GnosysLabs/iris). Single-binary
sidecar pattern — same web code, native window chrome, Sparkle auto-updates.

## License

MIT — see [LICENSE](./LICENSE).
