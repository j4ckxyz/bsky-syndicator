import { UnrecoverableError, Worker, type Job } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { QUEUE_NAMES, QueueManager, createJobId } from "../core/queue.js";
import type { CrossPostJobData, PlatformName } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import type { PlatformAdapter } from "../adapters/base.js";
import { TwitterDailyLimitError } from "../adapters/twitter.js";
import { decodePostFromQueue } from "../core/job-serialization.js";

const MIN_429_DELAY_MS = 60_000;

function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };

  for (const value of [candidate.code, candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  if (typeof candidate.message === "string") {
    const directMatch = candidate.message.match(/\b(4\d{2}|5\d{2})\b/);
    if (directMatch) {
      return Number(directMatch[1]);
    }
  }

  return undefined;
}

function isPermanentClientError(statusCode: number | undefined): boolean {
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return undefined;
}

function toHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string");
    return first;
  }

  return undefined;
}

function extractTwitter429DelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const now = Date.now();
  const candidate = error as {
    rateLimit?: {
      reset?: unknown;
      day?: { reset?: unknown };
      userDay?: { reset?: unknown };
    };
    headers?: Record<string, unknown>;
  };
  const headers = candidate.headers ?? {};
  const resetCandidates: number[] = [];

  const retryAfterHeader = toHeaderValue(headers["retry-after"]);
  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      resetCandidates.push(now + retryAfterSeconds * 1000);
    } else {
      const retryAfterDate = Date.parse(retryAfterHeader);
      if (Number.isFinite(retryAfterDate) && retryAfterDate > now) {
        resetCandidates.push(retryAfterDate);
      }
    }
  }

  const maybeEpochSeconds = [
    candidate.rateLimit?.reset,
    candidate.rateLimit?.day?.reset,
    candidate.rateLimit?.userDay?.reset,
    headers["x-rate-limit-reset"],
    headers["x-app-limit-24hour-reset"],
    headers["x-user-limit-24hour-reset"]
  ];

  for (const value of maybeEpochSeconds) {
    const numeric = toNumber(value);
    if (!numeric || numeric <= 0) {
      continue;
    }

    resetCandidates.push(numeric > 1e12 ? numeric : numeric * 1000);
  }

  const futureResets = resetCandidates.filter((value) => value > now);
  if (futureResets.length === 0) {
    return undefined;
  }

  const targetTime = Math.max(...futureResets);
  return Math.max(targetTime - now, MIN_429_DELAY_MS);
}

export class CrosspostWorkers {
  private readonly log = logger.child({ module: "workers/crosspost" });
  private readonly queueManager: QueueManager;
  private readonly db: AppDatabase;
  private readonly adapters: Map<PlatformName, PlatformAdapter>;
  private readonly workers: Worker<CrossPostJobData>[] = [];

  constructor(params: {
    queueManager: QueueManager;
    db: AppDatabase;
    adapters: PlatformAdapter[];
  }) {
    this.queueManager = params.queueManager;
    this.db = params.db;
    this.adapters = new Map(params.adapters.map((adapter) => [adapter.name, adapter]));
  }

  start(): void {
    for (const [platform, adapter] of this.adapters.entries()) {
      const queueName = QUEUE_NAMES[platform];
      const isTwitter = platform === "twitter";

      const worker = new Worker<CrossPostJobData>(
        queueName,
        async (job) => this.processJob(job, adapter),
        {
          connection: this.queueManager.connectionOptions,
          concurrency: isTwitter ? 1 : 4,
          limiter: isTwitter
            ? {
                max: 1,
                duration: env.TWITTER_MIN_POST_INTERVAL_MS
              }
            : undefined
        }
      );

      worker.on("completed", (job) => {
        const sourceUri = job.data.action === "post" ? job.data.post.sourceUri : job.data.sourceUri;
        this.log.info(
          {
            jobId: job.id,
            platform,
            sourceUri,
            action: job.data.action
          },
          "Cross-post job completed"
        );
      });

      worker.on("failed", (job, error) => {
        const sourceUri =
          job?.data.action === "post" ? job.data.post.sourceUri : job?.data.sourceUri;
        this.log.error(
          {
            jobId: job?.id,
            platform,
            sourceUri,
            action: job?.data.action,
            error: error?.message
          },
          "Cross-post job failed"
        );
      });

      this.workers.push(worker);
      this.log.info(
        {
          queueName,
          platform,
          concurrency: isTwitter ? 1 : 4,
          minPostIntervalMs: isTwitter ? env.TWITTER_MIN_POST_INTERVAL_MS : undefined
        },
        "Worker started"
      );
    }
  }

  private async processJob(job: Job<CrossPostJobData>, adapter: PlatformAdapter): Promise<void> {
    if (job.data.action === "delete") {
      const { sourceUri } = job.data;
      try {
        await adapter.delete(sourceUri);
        this.db.recordPlatformDeletion({
          uri: sourceUri,
          platform: job.data.platform
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.recordPlatformFailure({
          uri: sourceUri,
          platform: job.data.platform,
          error: message
        });

        const statusCode = extractStatusCode(error);
        if (isPermanentClientError(statusCode)) {
          throw new UnrecoverableError(message);
        }

        throw error;
      }
      return;
    }

    const post = decodePostFromQueue(job.data.post);

    try {
      const result = await adapter.post(post);

      this.db.recordPlatformSuccess({
        uri: post.sourceUri,
        platform: job.data.platform,
        remoteId: result.id,
        remoteIds: result.threadIds,
        remoteUrl: result.url
      });
    } catch (error) {
      const statusCode = extractStatusCode(error);

      if (error instanceof TwitterDailyLimitError && job.data.platform === "twitter") {
        await this.queueManager.queues.twitter.add(
          "twitter-crosspost-delayed",
          job.data,
          {
            delay: error.delayMs,
            jobId: createJobId("twitter", post.sourceUri, `defer-${error.day}`)
          }
        );

        this.log.warn(
          {
            sourceUri: post.sourceUri,
            day: error.day,
            currentCount: error.currentCount,
            limit: error.limit,
            delayedForMs: error.delayMs
          },
          "Twitter daily cap reached; job delayed to next UTC day"
        );
        return;
      }

      if (job.data.platform === "twitter" && statusCode === 429) {
        const delayMs = Math.max(
          extractTwitter429DelayMs(error) ?? env.TWITTER_MIN_POST_INTERVAL_MS,
          MIN_429_DELAY_MS
        );

        await this.queueManager.queues.twitter.add(
          "twitter-crosspost-rate-limited",
          job.data,
          {
            delay: delayMs,
            jobId: createJobId(
              "twitter",
              post.sourceUri,
              `rl-${Math.floor(Date.now() / 1000)}`
            )
          }
        );

        this.log.warn(
          {
            sourceUri: post.sourceUri,
            delayedForMs: delayMs,
            retryAt: new Date(Date.now() + delayMs).toISOString()
          },
          "Twitter returned 429; delayed job before retrying"
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.db.recordPlatformFailure({
        uri: post.sourceUri,
        platform: job.data.platform,
        error: message
      });

      if (isPermanentClientError(statusCode)) {
        throw new UnrecoverableError(message);
      }

      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
