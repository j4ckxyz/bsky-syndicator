import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  BLUESKY_SERVICE: z.string().url().default("https://bsky.social"),
  BLUESKY_IDENTIFIER: z.string().min(1, "BLUESKY_IDENTIFIER is required"),
  BLUESKY_PASSWORD: z.string().min(1, "BLUESKY_PASSWORD is required"),
  BLUESKY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  BLUESKY_FEED_LIMIT: z.coerce.number().int().min(1).max(100).default(50),

  MASTODON_INSTANCE: optionalUrl,
  MASTODON_ACCESS_TOKEN: z.string().optional(),

  NOSTR_PRIVATE_KEY: z.string().optional(),
  NOSTR_RELAYS: z.string().default("wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band"),
  NOSTR_MEDIA_HOST: z.string().url().default("https://nostr.build"),

  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_SECRET: z.string().optional(),
  TWITTER_DAILY_LIMIT: z.coerce.number().int().positive().default(17),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  DB_PATH: z.string().default("./data/syndicator.db")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${details}`);
}

const dbPath = parsed.data.DB_PATH;

export const env = {
  ...parsed.data,
  DB_PATH: path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath),
  nostrRelays: parsed.data.NOSTR_RELAYS.split(",")
    .map((relay) => relay.trim())
    .filter(Boolean)
};

export const platformConfig = {
  mastodonEnabled: Boolean(env.MASTODON_INSTANCE && env.MASTODON_ACCESS_TOKEN),
  nostrEnabled: Boolean(env.NOSTR_PRIVATE_KEY && env.nostrRelays.length > 0),
  twitterEnabled: Boolean(
    env.TWITTER_API_KEY &&
      env.TWITTER_API_SECRET &&
      env.TWITTER_ACCESS_TOKEN &&
      env.TWITTER_ACCESS_SECRET
  )
};

export type Env = typeof env;
