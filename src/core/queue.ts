import { createHash } from "node:crypto";
import net from "node:net";
import { Queue, type JobsOptions } from "bullmq";
import { env } from "../config/env.js";
import type { CrossPost, CrossPostJobData, PlatformName } from "./types.js";

export const QUEUE_NAMES: Record<PlatformName, string> = {
  mastodon: "crosspost-mastodon",
  nostr: "crosspost-nostr",
  twitter: "crosspost-twitter"
};

export function createJobId(platform: PlatformName, sourceUri: string, suffix?: string): string {
  const digest = createHash("sha256").update(sourceUri).digest("hex").slice(0, 20);
  return suffix ? `${platform}-${digest}-${suffix}` : `${platform}-${digest}`;
}

export function parseRedisConnection(redisUrl: string): {
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

export async function assertRedisReachable(redisUrl: string, timeoutMs = 3000): Promise<void> {
  const connection = parseRedisConnection(redisUrl);

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({
      host: connection.host,
      port: connection.port
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(
          new Error(
            `Could not connect to Redis at ${connection.host}:${connection.port}. ` +
              "Start Redis and verify REDIS_URL."
          )
        );
      });
    }, timeoutMs);

    socket.once("connect", () => {
      finish(() => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
    });

    socket.once("error", (error) => {
      finish(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `Could not connect to Redis at ${connection.host}:${connection.port}: ${error.message}`
          )
        );
      });
    });
  });
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
        const jobName = `${platform}-crosspost`;
        return this.queues[platform].add(
          jobName,
          {
            platform,
            post
          },
          {
            jobId: createJobId(platform, post.sourceUri)
          }
        );
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}
