import { Worker, type Job } from "bullmq";
import { logger } from "../config/logger.js";
import { QUEUE_NAMES, QueueManager, createJobId } from "../core/queue.js";
import type { CrossPostJobData, PlatformName } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import type { PlatformAdapter } from "../adapters/base.js";
import { TwitterDailyLimitError } from "../adapters/twitter.js";

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

      const worker = new Worker<CrossPostJobData>(
        queueName,
        async (job) => this.processJob(job, adapter),
        {
          connection: this.queueManager.connectionOptions,
          concurrency: 4
        }
      );

      worker.on("completed", (job) => {
        this.log.info(
          {
            jobId: job.id,
            platform,
            sourceUri: job.data.post.sourceUri
          },
          "Cross-post job completed"
        );
      });

      worker.on("failed", (job, error) => {
        this.log.error(
          {
            jobId: job?.id,
            platform,
            sourceUri: job?.data.post.sourceUri,
            error: error?.message
          },
          "Cross-post job failed"
        );
      });

      this.workers.push(worker);
      this.log.info({ queueName, platform }, "Worker started");
    }
  }

  private async processJob(job: Job<CrossPostJobData>, adapter: PlatformAdapter): Promise<void> {
    try {
      const result = await adapter.post(job.data.post);

      this.db.recordPlatformSuccess({
        uri: job.data.post.sourceUri,
        platform: job.data.platform,
        remoteId: result.id,
        remoteUrl: result.url
      });
    } catch (error) {
      if (error instanceof TwitterDailyLimitError && job.data.platform === "twitter") {
        await this.queueManager.queues.twitter.add(
          "twitter-crosspost-delayed",
          job.data,
          {
            delay: error.delayMs,
            jobId: createJobId("twitter", job.data.post.sourceUri, `defer-${error.day}`)
          }
        );

        this.log.warn(
          {
            sourceUri: job.data.post.sourceUri,
            day: error.day,
            currentCount: error.currentCount,
            limit: error.limit,
            delayedForMs: error.delayMs
          },
          "Twitter daily cap reached; job delayed to next UTC day"
        );
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.db.recordPlatformFailure({
        uri: job.data.post.sourceUri,
        platform: job.data.platform,
        error: message
      });

      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
