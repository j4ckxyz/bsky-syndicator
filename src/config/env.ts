import path from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional()
);

function parseCookieValue(cookie: string | undefined, key: string): string | undefined {
  if (!cookie) {
    return undefined;
  }

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return match?.[1];
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  BLUESKY_SERVICE: z.string().url().default("https://bsky.social"),
  BLUESKY_IDENTIFIER: z.string().min(1, "BLUESKY_IDENTIFIER is required"),
  BLUESKY_PASSWORD: z.string().min(1, "BLUESKY_PASSWORD is required"),
  BLUESKY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  BLUESKY_FEED_LIMIT: z.coerce.number().int().min(1).max(100).default(50),
  BLUESKY_DELETE_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  BLUESKY_DELETE_SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(1000).default(100),

  MASTODON_INSTANCE: optionalUrl,
  MASTODON_ACCESS_TOKEN: z.string().optional(),

  NOSTR_PRIVATE_KEY: z.string().optional(),
  NOSTR_RELAYS: z.string().default("wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band"),
  NOSTR_MEDIA_HOST: z.string().url().default("https://nostr.build"),

  TWITTER_AUTH_TOKEN: optionalString,
  TWITTER_CT0: optionalString,
  TWITTER_WEB_COOKIE_EXTRA: optionalString,
  TWITTER_WEB_COOKIE: optionalString,
  TWITTER_WEB_CSRF_TOKEN: optionalString,
  TWITTER_WEB_BEARER_TOKEN: z
    .string()
    .default(
      "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
    ),
  TWITTER_WEB_BASE_URL: z.string().url().default("https://twitter.com"),
  TWITTER_UPLOAD_BASE_URL: z.string().url().default("https://upload.twitter.com"),
  TWITTER_WEB_CLIENT_LANGUAGE: z.string().default("en"),
  TWITTER_CREATE_TWEET_QUERY_ID: z.string().default("I_J3_LvnnihD0Gjbq5pD2g"),
  TWITTER_DELETE_TWEET_QUERY_ID: z.string().default("VaenaVgh5q5ih7kvyVjgtg"),
  TWITTER_DAILY_LIMIT: z.coerce.number().int().positive().default(17),
  TWITTER_MIN_POST_INTERVAL_MS: z.coerce.number().int().positive().optional(),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
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
const twitterAuthToken =
  parsed.data.TWITTER_AUTH_TOKEN ?? parseCookieValue(parsed.data.TWITTER_WEB_COOKIE, "auth_token");
const twitterCt0 =
  parsed.data.TWITTER_CT0 ??
  parsed.data.TWITTER_WEB_CSRF_TOKEN ??
  parseCookieValue(parsed.data.TWITTER_WEB_COOKIE, "ct0");
const twitterCookieExtra = parsed.data.TWITTER_WEB_COOKIE_EXTRA
  ? parsed.data.TWITTER_WEB_COOKIE_EXTRA.trim().replace(/^;\s*/, "").replace(/;\s*$/, "")
  : undefined;
const twitterWebCookie =
  parsed.data.TWITTER_WEB_COOKIE ??
  [twitterAuthToken ? `auth_token=${twitterAuthToken}` : undefined, twitterCt0 ? `ct0=${twitterCt0}` : undefined, twitterCookieExtra]
    .filter((item): item is string => Boolean(item))
    .join("; ");
const twitterMinPostIntervalMs =
  parsed.data.TWITTER_MIN_POST_INTERVAL_MS ??
  Math.ceil((24 * 60 * 60 * 1000) / parsed.data.TWITTER_DAILY_LIMIT);

export const env = {
  ...parsed.data,
  TWITTER_AUTH_TOKEN: twitterAuthToken,
  TWITTER_CT0: twitterCt0,
  TWITTER_WEB_COOKIE_EXTRA: twitterCookieExtra,
  TWITTER_WEB_COOKIE: twitterWebCookie || undefined,
  TWITTER_WEB_CSRF_TOKEN: twitterCt0,
  TWITTER_MIN_POST_INTERVAL_MS: twitterMinPostIntervalMs,
  DB_PATH: path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath),
  nostrRelays: parsed.data.NOSTR_RELAYS.split(",")
    .map((relay) => relay.trim())
    .filter(Boolean)
};

export const platformConfig = {
  mastodonEnabled: Boolean(env.MASTODON_INSTANCE && env.MASTODON_ACCESS_TOKEN),
  nostrEnabled: Boolean(env.NOSTR_PRIVATE_KEY && env.nostrRelays.length > 0),
  twitterEnabled: Boolean(env.TWITTER_AUTH_TOKEN && env.TWITTER_CT0)
};

export type Env = typeof env;
