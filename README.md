# Bluesky Syndicator

Background TypeScript service that treats Bluesky as the source of truth and cross-posts new posts to Mastodon, Nostr, and Twitter/X.

## Features

- Bluesky source polling via official `@atproto/api`
- Independent async pipelines per target platform (BullMQ + Redis)
- Failure isolation: one platform failing does not block the others
- Automatic retries with exponential backoff
- SQLite deduplication so the same Bluesky post is not re-enqueued on restart
- Twitter daily cap via `TWITTER_DAILY_LIMIT` (count-based budget guard)
- Thread-aware text splitting for Twitter (280) and Mastodon (instance limit)
- Media + alt-text carry-over:
  - Mastodon: media upload descriptions
  - Twitter: media metadata alt text
  - Nostr: uploads via nostr.build (NIP-96 + NIP-98 auth)
- Structured logs with Pino

## Runtime Requirements

- Node.js 18+ (22+ recommended)
- Bun 1.x (recommended package manager for install/dev)
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

## Development

```bash
bun run dev
```

## Build and Run

```bash
bun run build
bun run start
```

## Docker

```bash
docker compose up --build
```

## Configuration

See `.env.example` for all variables.

Important settings:

- `BLUESKY_SERVICE` supports third-party PDS URLs
- `MASTODON_INSTANCE` supports any Mastodon-compatible instance URL
- `TWITTER_DAILY_LIMIT` caps total tweet writes per UTC day

## Architecture

```text
Bluesky poller
  -> normalize post
  -> enqueue jobs:
      - crosspost:mastodon
      - crosspost:nostr
      - crosspost:twitter

workers (independent)
  -> post + retry + log + persist result
```
