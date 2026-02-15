import { Queue, type JobsOptions } from "bullmq";
import { env } from "../config/env.js";
import type { CrossPost, CrossPostJobData, PlatformName } from "./types.js";

export const QUEUE_NAMES: Record<PlatformName, string> = {
  mastodon: "crosspost:mastodon",
  nostr: "crosspost:nostr",
  twitter: "crosspost:twitter"
};

function parseRedisConnection(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
} {
  const parsed = new URL(redisUrl);
  const db = parsed.pathname?.replace("/", "");

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: db ? Number(db) : undefined
  };
}

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 10_000
  },
  removeOnComplete: {
    age: 60 * 60 * 24,
    count: 1000
  },
  removeOnFail: {
    age: 60 * 60 * 24 * 7,
    count: 5000
  }
};

export class QueueManager {
  readonly connectionOptions: ReturnType<typeof parseRedisConnection>;
  readonly queues: Record<PlatformName, Queue<CrossPostJobData>>;

  constructor(redisUrl = env.REDIS_URL) {
    this.connectionOptions = parseRedisConnection(redisUrl);

    this.queues = {
      mastodon: new Queue<CrossPostJobData>(QUEUE_NAMES.mastodon, {
        connection: this.connectionOptions,
        defaultJobOptions
      }),
      nostr: new Queue<CrossPostJobData>(QUEUE_NAMES.nostr, {
        connection: this.connectionOptions,
        defaultJobOptions
      }),
      twitter: new Queue<CrossPostJobData>(QUEUE_NAMES.twitter, {
        connection: this.connectionOptions,
        defaultJobOptions
      })
    };
  }

  async enqueuePost(post: CrossPost, platforms: PlatformName[]): Promise<void> {
    await Promise.all(
      platforms.map((platform) => {
        const jobName = `${platform}:${post.sourceUri}`;
        return this.queues[platform].add(
          jobName,
          {
            platform,
            post
          },
          {
            jobId: `${platform}:${post.sourceUri}`
          }
        );
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}
