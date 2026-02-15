# Bluesky Syndicator

Background TypeScript service that treats Bluesky as the source of truth and cross-posts new posts to Mastodon, Nostr, and Twitter/X.

## Features

- Bluesky source polling via official `@atproto/api`
- Only cross-posts top-level posts and replies within your own root threads
- Independent async pipelines per target platform (BullMQ + Redis)
- Failure isolation: one platform failing does not block the others
- Automatic retries with exponential backoff
- SQLite deduplication so the same Bluesky post is not re-enqueued on restart
- Deletion sync: when a tracked Bluesky post is deleted, linked Mastodon/Nostr/Twitter posts are deleted too
- Twitter posting/deletion via internal web endpoints (OldTwitter-style: chunked media upload + GraphQL CreateTweet/DeleteTweet)
- Twitter daily cap via `TWITTER_DAILY_LIMIT` (count-based budget guard)
- Twitter pacing guard (`TWITTER_MIN_POST_INTERVAL_MS`) to spread writes and avoid bursty 429s
- Thread-aware text splitting for Twitter (280) and Mastodon (instance limit)
- Media + alt-text carry-over:
  - Mastodon: image/video uploads with descriptions
  - Twitter: image/video uploads with media metadata alt text
  - Nostr: uploads via nostr.build (NIP-96 + NIP-98 auth)
- Self-quote support: includes quoted text with original date context on target platforms
- Structured logs with Pino

## Runtime Requirements

- Node.js 18+ (22+ recommended)
- Bun 1.x (recommended package manager for install)
- Redis 7+
- Linux x64 or arm64 (Raspberry Pi 64-bit supported)

## Setup

1. Install dependencies:

```bash
bun install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Fill in credentials in `.env`.

4. Ensure Redis is running (required by BullMQ):

```bash
docker run -d --name bsky-redis -p 6379:6379 redis:7-alpine
```

On Debian/Raspberry Pi OS you can also install via apt:

```bash
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable --now redis-server || sudo systemctl enable --now redis
```

## Development

```bash
bun run dev
```

`dev` runs via `tsx` on Node.js (not Bun runtime), which is required because `better-sqlite3` is not supported by Bun runtime yet.

## Build and Run

```bash
bun run build
bun run start
```

If Redis is unreachable, the app exits early with a clear startup error.

## Docker

```bash
docker compose up --build
```

## Run as a service (systemd)

Use the same Node binary for install and runtime. If dependencies were installed with one Node
version and systemd runs another, native modules like `better-sqlite3` will fail to load.

1. Check your active Node path:

```bash
which node
readlink -f "$(which node)"
```

Use the `readlink -f` result (stable path). Avoid transient paths under `/run/user/...`
when writing `ExecStart`, because those can break after reboot.

2. Create a service file using that exact Node path in `ExecStart`:

```ini
[Unit]
Description=Bluesky Syndicator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
Group=pi
WorkingDirectory=/home/pi/bsky-syndicator
EnvironmentFile=/home/pi/bsky-syndicator/.env
ExecStart=/path/to/your/node /home/pi/bsky-syndicator/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

3. Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bsky-syndicator
sudo systemctl status bsky-syndicator
```

If you see a `NODE_MODULE_VERSION` mismatch error, reinstall dependencies with the same Node
binary used by `ExecStart`.

## Configuration

See `.env.example` for all variables.

Important settings:

- `BLUESKY_SERVICE` supports third-party PDS URLs
- `BLUESKY_DELETE_SYNC_INTERVAL_MS` controls how often deletions are reconciled
- `MASTODON_INSTANCE` supports any Mastodon-compatible instance URL
- `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` are the primary Twitter session credentials
- `TWITTER_WEB_COOKIE_EXTRA` can append additional cookie pairs when needed
- `TWITTER_WEB_COOKIE` remains supported as a legacy full-cookie fallback
- `TWITTER_DAILY_LIMIT` caps total tweet writes per UTC day
- `TWITTER_MIN_POST_INTERVAL_MS` spaces out Twitter jobs (defaults to `24h / TWITTER_DAILY_LIMIT`)

## Architecture

```text
Bluesky poller
  -> normalize post
  -> enqueue jobs:
      - crosspost-mastodon
      - crosspost-nostr
      - crosspost-twitter

workers (independent)
  -> post + retry + log + persist result
```
