import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { PlatformAdapter } from "./base.js";
import type { CrossPost, MediaAsset, PostResult } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import { countByTwitterRules, splitIntoThread } from "../core/text-splitter.js";
import { buildPostTextWithSelfQuote } from "../core/quote-context.js";

const MAX_MEDIA_ATTACHMENTS = 4;
const MEDIA_CHUNK_SIZE = 1_084_576;
const MEDIA_STATUS_MAX_POLLS = 1_200;

const CREATE_TWEET_FEATURES = {
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_home_pinned_timelines_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false
} as const;

interface UploadProcessingInfo {
  state?: string;
  check_after_secs?: number;
  progress_percent?: number;
  error?: {
    code?: number;
    name?: string;
    message?: string;
  };
}

interface UploadResponse {
  media_id_string?: string;
  processing_info?: UploadProcessingInfo;
  errors?: Array<{ message?: string }>;
}

interface CreateTweetResponse {
  data?: {
    create_tweet?: {
      tweet_results?: {
        result?: {
          rest_id?: string;
          legacy?: {
            id_str?: string;
          };
          tweet?: {
            rest_id?: string;
          };
        };
      };
    };
    notetweet_create?: {
      tweet_results?: {
        result?: {
          rest_id?: string;
          legacy?: {
            id_str?: string;
          };
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

function toUtcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function msUntilNextUtcMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headersToRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    output[name.toLowerCase()] = value;
  }
  return output;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function buildRateLimit(headers: Record<string, string>):
  | {
      reset?: number;
      day?: { reset?: number };
      userDay?: { reset?: number };
    }
  | undefined {
  const reset = parseNumber(headers["x-rate-limit-reset"]);
  const dayReset = parseNumber(headers["x-app-limit-24hour-reset"]);
  const userDayReset = parseNumber(headers["x-user-limit-24hour-reset"]);

  if (!reset && !dayReset && !userDayReset) {
    return undefined;
  }

  return {
    reset,
    day: dayReset ? { reset: dayReset } : undefined,
    userDay: userDayReset ? { reset: userDayReset } : undefined
  };
}

function firstApiErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as {
    errors?: Array<{ message?: unknown }>;
    error?: unknown;
    detail?: unknown;
    title?: unknown;
  };

  if (Array.isArray(candidate.errors) && candidate.errors[0] && typeof candidate.errors[0].message === "string") {
    return candidate.errors[0].message;
  }

  if (typeof candidate.error === "string") {
    return candidate.error;
  }

  if (typeof candidate.detail === "string") {
    return candidate.detail;
  }

  if (typeof candidate.title === "string") {
    return candidate.title;
  }

  return undefined;
}

function extractTweetId(payload: CreateTweetResponse): string | undefined {
  return (
    payload.data?.create_tweet?.tweet_results?.result?.rest_id ??
    payload.data?.create_tweet?.tweet_results?.result?.legacy?.id_str ??
    payload.data?.create_tweet?.tweet_results?.result?.tweet?.rest_id ??
    payload.data?.notetweet_create?.tweet_results?.result?.rest_id ??
    payload.data?.notetweet_create?.tweet_results?.result?.legacy?.id_str
  );
}

class TwitterWebApiError extends Error {
  readonly code: number;
  readonly status: number;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly rateLimit?: {
    reset?: number;
    day?: { reset?: number };
    userDay?: { reset?: number };
  };

  constructor(message: string, params: { statusCode: number; headers: Record<string, string> }) {
    super(message);
    this.name = "TwitterWebApiError";
    this.code = params.statusCode;
    this.status = params.statusCode;
    this.statusCode = params.statusCode;
    this.headers = params.headers;
    this.rateLimit = buildRateLimit(params.headers);
  }
}

export class TwitterDailyLimitError extends Error {
  readonly delayMs: number;
  readonly day: string;
  readonly currentCount: number;
  readonly attemptedPosts: number;
  readonly limit: number;

  constructor(params: {
    day: string;
    currentCount: number;
    attemptedPosts: number;
    limit: number;
    delayMs: number;
  }) {
    super(
      `Twitter daily cap reached (${params.currentCount}/${params.limit}) on ${params.day}. Delaying ${params.attemptedPosts} post(s).`
    );
    this.name = "TwitterDailyLimitError";
    this.delayMs = params.delayMs;
    this.day = params.day;
    this.currentCount = params.currentCount;
    this.attemptedPosts = params.attemptedPosts;
    this.limit = params.limit;
  }
}

export class TwitterAdapter implements PlatformAdapter {
  readonly name = "twitter" as const;
  private readonly log = logger.child({ module: "adapters/twitter" });
  private readonly db: AppDatabase;
  private readonly apiBaseUrl = env.TWITTER_WEB_BASE_URL.replace(/\/$/, "");
  private readonly uploadBaseUrl = env.TWITTER_UPLOAD_BASE_URL.replace(/\/$/, "");

  private cookie = "";
  private csrfToken = "";

  constructor(db: AppDatabase) {
    this.db = db;
  }

  async init(): Promise<void> {
    if (!env.TWITTER_AUTH_TOKEN) {
      throw new Error("TWITTER_AUTH_TOKEN is required for Twitter adapter");
    }

    if (!env.TWITTER_CT0) {
      throw new Error("TWITTER_CT0 is required for Twitter adapter");
    }

    this.csrfToken = env.TWITTER_CT0;
    this.cookie =
      env.TWITTER_WEB_COOKIE ??
      [`auth_token=${env.TWITTER_AUTH_TOKEN}`, `ct0=${env.TWITTER_CT0}`, env.TWITTER_WEB_COOKIE_EXTRA]
        .filter((item): item is string => Boolean(item))
        .join("; ");

    this.log.info(
      {
        dailyLimit: env.TWITTER_DAILY_LIMIT,
        minPostIntervalMs: env.TWITTER_MIN_POST_INTERVAL_MS,
        apiBaseUrl: this.apiBaseUrl,
        uploadBaseUrl: this.uploadBaseUrl
      },
      "Initialized Twitter adapter (web API mode)"
    );
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: env.TWITTER_WEB_BEARER_TOKEN,
      "x-csrf-token": this.csrfToken,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": env.TWITTER_WEB_CLIENT_LANGUAGE,
      cookie: this.cookie,
      ...extra
    };
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const responseHeaders = headersToRecord(response.headers);
    const rawText = await response.text();

    let payload: unknown = {};
    if (rawText.trim().length > 0) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { raw: rawText };
      }
    }

    if (!response.ok) {
      const message =
        firstApiErrorMessage(payload) ??
        (typeof (payload as { raw?: unknown }).raw === "string"
          ? (payload as { raw: string }).raw
          : `Twitter request failed (${response.status}): ${response.statusText}`);

      throw new TwitterWebApiError(message, {
        statusCode: response.status,
        headers: responseHeaders
      });
    }

    const apiError = firstApiErrorMessage(payload);
    if (apiError) {
      throw new Error(apiError);
    }

    return payload as T;
  }

  private async fetchOk(url: string, init: RequestInit): Promise<void> {
    const response = await fetch(url, init);
    if (response.ok) {
      return;
    }

    const responseHeaders = headersToRecord(response.headers);
    const rawText = await response.text();

    let payload: unknown;
    try {
      payload = rawText.trim() ? JSON.parse(rawText) : undefined;
    } catch {
      payload = { raw: rawText };
    }

    const fallbackText = rawText.trim();
    const message =
      firstApiErrorMessage(payload) ??
      (fallbackText || `Twitter request failed (${response.status}): ${response.statusText}`);

    throw new TwitterWebApiError(message, {
      statusCode: response.status,
      headers: responseHeaders
    });
  }

  private mediaCategory(media: MediaAsset): "tweet_image" | "tweet_video" | "tweet_gif" {
    const mime = media.mimeType.toLowerCase();

    if (mime === "image/gif" || media.filename?.toLowerCase().endsWith(".gif")) {
      return "tweet_gif";
    }

    if (mime.startsWith("video/") || media.type === "video") {
      return "tweet_video";
    }

    return "tweet_image";
  }

  private async setMediaMetadata(mediaId: string, media: MediaAsset): Promise<void> {
    if (!media.altText) {
      return;
    }

    try {
      await this.fetchJson<Record<string, unknown>>(`${this.uploadBaseUrl}/1.1/media/metadata/create.json`, {
        method: "POST",
        headers: this.buildHeaders({
          "content-type": "application/json"
        }),
        body: JSON.stringify({
          media_id: mediaId,
          alt_text: {
            text: media.altText.slice(0, 1000)
          }
        })
      });
    } catch (error) {
      this.log.warn(
        {
          mediaId,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to attach Twitter media metadata; continuing"
      );
    }
  }

  private async waitForMediaProcessing(mediaId: string, processing: UploadProcessingInfo): Promise<void> {
    let info: UploadProcessingInfo | undefined = processing;

    for (let attempt = 0; attempt < MEDIA_STATUS_MAX_POLLS; attempt += 1) {
      const state = info?.state;

      if (!state || state === "succeeded") {
        return;
      }

      if (state === "failed") {
        const details = info?.error;
        if (details?.message) {
          throw new Error(details.message);
        }

        throw new Error(
          `Twitter rejected media${
            details?.code ? ` with code ${details.code}` : ""
          }${details?.name ? ` (${details.name})` : ""}`
        );
      }

      if (state !== "pending" && state !== "in_progress") {
        throw new Error(`Unexpected Twitter media processing state: ${state}`);
      }

      const waitMs = Math.max(1, info?.check_after_secs ?? 1) * 1000;
      await sleep(waitMs);

      const statusResponse = await this.fetchJson<UploadResponse>(
        `${this.uploadBaseUrl}/1.1/media/upload.json?${new URLSearchParams({
          command: "STATUS",
          media_id: mediaId
        }).toString()}`,
        {
          method: "GET",
          headers: this.buildHeaders({
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
          })
        }
      );

      info = statusResponse.processing_info;
    }

    throw new Error("Timed out while waiting for Twitter media processing to finish");
  }

  private async uploadSingleMedia(media: MediaAsset): Promise<string> {
    const initPayload = new URLSearchParams({
      command: "INIT",
      total_bytes: String(media.data.byteLength),
      media_type: media.mimeType,
      media_category: this.mediaCategory(media)
    });

    const initResponse = await this.fetchJson<UploadResponse>(`${this.uploadBaseUrl}/1.1/media/upload.json`, {
      method: "POST",
      headers: this.buildHeaders({
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      }),
      body: initPayload.toString()
    });

    const mediaId = initResponse.media_id_string;
    if (!mediaId) {
      throw new Error("Twitter media INIT did not return media_id_string");
    }

    const totalSegments = Math.ceil(media.data.byteLength / MEDIA_CHUNK_SIZE);

    for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex += 1) {
      const start = segmentIndex * MEDIA_CHUNK_SIZE;
      const end = Math.min(start + MEDIA_CHUNK_SIZE, media.data.byteLength);
      const chunk = media.data.subarray(start, end);

      const form = new FormData();
      form.set("command", "APPEND");
      form.set("media_id", mediaId);
      form.set("segment_index", String(segmentIndex));
      form.set(
        "media",
        new Blob([Uint8Array.from(chunk)], { type: media.mimeType }),
        media.filename ?? `media-${segmentIndex}`
      );

      await this.fetchOk(`${this.uploadBaseUrl}/1.1/media/upload.json`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: form
      });
    }

    const finalizeResponse = await this.fetchJson<UploadResponse>(`${this.uploadBaseUrl}/1.1/media/upload.json`, {
      method: "POST",
      headers: this.buildHeaders({
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      }),
      body: new URLSearchParams({
        command: "FINALIZE",
        media_id: mediaId
      }).toString()
    });

    await this.setMediaMetadata(mediaId, media);

    if (finalizeResponse.processing_info) {
      await this.waitForMediaProcessing(mediaId, finalizeResponse.processing_info);
    }

    return mediaId;
  }

  private async uploadMedia(post: CrossPost): Promise<string[]> {
    if (!post.media || post.media.length === 0) {
      return [];
    }

    const mediaIds: string[] = [];

    for (const media of post.media.slice(0, MAX_MEDIA_ATTACHMENTS)) {
      const mediaId = await this.uploadSingleMedia(media);
      mediaIds.push(mediaId);
    }

    return mediaIds;
  }

  private async createTweet(params: {
    text: string;
    mediaIds: string[];
    replyToTweetId?: string;
  }): Promise<string> {
    const variables: Record<string, unknown> = {
      tweet_text: params.text,
      media: {
        media_entities: params.mediaIds.map((mediaId) => ({
          media_id: mediaId,
          tagged_users: []
        })),
        possibly_sensitive: false
      },
      semantic_annotation_ids: [],
      dark_request: false
    };

    if (params.replyToTweetId) {
      variables.reply = {
        in_reply_to_tweet_id: params.replyToTweetId,
        exclude_reply_user_ids: []
      };
    }

    const queryId = env.TWITTER_CREATE_TWEET_QUERY_ID;
    const payload = await this.fetchJson<CreateTweetResponse>(
      `${this.apiBaseUrl}/i/api/graphql/${queryId}/CreateTweet`,
      {
        method: "POST",
        headers: this.buildHeaders({
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          variables,
          features: CREATE_TWEET_FEATURES,
          queryId
        })
      }
    );

    const tweetId = extractTweetId(payload);
    if (!tweetId) {
      throw new Error("Twitter CreateTweet response missing tweet id");
    }

    return tweetId;
  }

  private async deleteTweet(tweetId: string): Promise<void> {
    const queryId = env.TWITTER_DELETE_TWEET_QUERY_ID;

    await this.fetchJson<Record<string, unknown>>(`${this.apiBaseUrl}/i/api/graphql/${queryId}/DeleteTweet`, {
      method: "POST",
      headers: this.buildHeaders({
        "content-type": "application/json; charset=utf-8"
      }),
      body: JSON.stringify({
        variables: {
          tweet_id: tweetId,
          dark_request: false
        },
        queryId
      })
    });
  }

  async post(post: CrossPost): Promise<PostResult> {
    const text = buildPostTextWithSelfQuote({
      post,
      platform: this.name,
      db: this.db
    });

    const chunks = splitIntoThread(text, {
      maxLength: 280,
      countLength: countByTwitterRules,
      reserveForCounter: 8
    });

    const day = toUtcDay();
    const currentCount = this.db.getTwitterPostCount(day);

    if (currentCount + chunks.length > env.TWITTER_DAILY_LIMIT) {
      throw new TwitterDailyLimitError({
        day,
        currentCount,
        attemptedPosts: chunks.length,
        limit: env.TWITTER_DAILY_LIMIT,
        delayMs: msUntilNextUtcMidnight()
      });
    }

    const mediaIds = await this.uploadMedia(post);
    const parentReplyId = post.reply
      ? this.db.getPlatformRemoteId(post.reply.parentUri, this.name) ?? undefined
      : undefined;
    const rootReplyId = post.reply
      ? this.db.getPlatformRemoteId(post.reply.rootUri, this.name) ?? undefined
      : undefined;

    if (post.reply && !parentReplyId && !rootReplyId) {
      throw new Error(
        `Reply thread dependency not ready on Twitter for ${post.sourceUri}; waiting for parent/root cross-post`
      );
    }

    const inheritedReplyId = parentReplyId ?? rootReplyId;

    let replyToTweetId: string | undefined = inheritedReplyId;
    const threadIds: string[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const tweetId = await this.createTweet({
        text: chunks[index],
        mediaIds: index === 0 ? mediaIds : [],
        replyToTweetId
      });

      threadIds.push(tweetId);
      replyToTweetId = tweetId;
      this.db.incrementTwitterPostCount(day, 1);
    }

    return {
      id: threadIds[0],
      url: `https://x.com/i/web/status/${threadIds[0]}`,
      threadIds
    };
  }

  async delete(sourceUri: string): Promise<void> {
    const remoteIds = this.db.getPlatformRemoteIds(sourceUri, this.name);
    if (remoteIds.length === 0) {
      return;
    }

    for (const remoteId of [...remoteIds].reverse()) {
      try {
        await this.deleteTweet(remoteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode =
          typeof error === "object" && error && "statusCode" in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : undefined;

        const isAlreadyDeleted =
          statusCode === 404 ||
          message.includes("404") ||
          message.includes("Not Found") ||
          message.includes("No status found") ||
          message.includes("does not exist");

        if (!isAlreadyDeleted) {
          throw error;
        }
      }
    }
  }

  async destroy(): Promise<void> {
    this.log.info("Twitter adapter stopped");
  }
}
