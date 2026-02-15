import {
  TwitterApi,
  type SendTweetV2Params,
  type TwitterApiReadWrite
} from "twitter-api-v2";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { PlatformAdapter } from "./base.js";
import type { CrossPost, PostResult } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import { countByTwitterRules, splitIntoThread } from "../core/text-splitter.js";
import { buildPostTextWithSelfQuote } from "../core/quote-context.js";

function toUtcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function msUntilNextUtcMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
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
  private client!: TwitterApiReadWrite;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  async init(): Promise<void> {
    if (
      !env.TWITTER_API_KEY ||
      !env.TWITTER_API_SECRET ||
      !env.TWITTER_ACCESS_TOKEN ||
      !env.TWITTER_ACCESS_SECRET
    ) {
      throw new Error(
        "TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_SECRET are required"
      );
    }

    this.client = new TwitterApi({
      appKey: env.TWITTER_API_KEY,
      appSecret: env.TWITTER_API_SECRET,
      accessToken: env.TWITTER_ACCESS_TOKEN,
      accessSecret: env.TWITTER_ACCESS_SECRET
    }).readWrite;

    const me = await this.client.v2.me();
    this.log.info(
      {
        username: me.data.username,
        dailyLimit: env.TWITTER_DAILY_LIMIT
      },
      "Initialized Twitter adapter"
    );
  }

  private async uploadMedia(post: CrossPost): Promise<string[]> {
    if (!post.media || post.media.length === 0) {
      return [];
    }

    const mediaIds: string[] = [];

    for (const media of post.media.slice(0, 4)) {
      const mediaId = await this.client.v1.uploadMedia(media.data, {
        mimeType: media.mimeType,
        target: "tweet"
      });

      if (media.altText) {
        await this.client.v1.createMediaMetadata(mediaId, {
          alt_text: {
            text: media.altText.slice(0, 1000)
          }
        });
      }

      mediaIds.push(mediaId);
    }

    return mediaIds;
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
    const mediaPayload =
      mediaIds.length > 0
        ? {
            media_ids: mediaIds as SendTweetV2Params["media"] extends { media_ids: infer T }
              ? T
              : never
          }
        : undefined;

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
      const created = await this.client.v2.tweet({
        text: chunks[index],
        media: index === 0 ? mediaPayload : undefined,
        reply: replyToTweetId ? { in_reply_to_tweet_id: replyToTweetId } : undefined
      });

      const tweetId = created.data.id;
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
        await this.client.v2.deleteTweet(remoteId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("404") && !message.includes("Not Found")) {
          throw error;
        }
      }
    }
  }

  async destroy(): Promise<void> {
    this.log.info("Twitter adapter stopped");
  }
}
