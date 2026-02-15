import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { BlueskySourceAdapter } from "../adapters/bluesky.js";
import { AppDatabase } from "./db.js";
import { QueueManager } from "./queue.js";
import type { PlatformName } from "./types.js";
import { normalizeFeedPost } from "./post-normalizer.js";

export class BlueskyPoller {
  private readonly log = logger.child({ module: "core/poller" });
  private readonly source: BlueskySourceAdapter;
  private readonly db: AppDatabase;
  private readonly queueManager: QueueManager;
  private readonly targetPlatforms: PlatformName[];

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastDeletionSyncAt = 0;

  constructor(params: {
    source: BlueskySourceAdapter;
    db: AppDatabase;
    queueManager: QueueManager;
    targetPlatforms: PlatformName[];
  }) {
    this.source = params.source;
    this.db = params.db;
    this.queueManager = params.queueManager;
    this.targetPlatforms = params.targetPlatforms;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.log.info(
      {
        intervalMs: env.BLUESKY_POLL_INTERVAL_MS,
        targets: this.targetPlatforms
      },
      "Starting Bluesky poller"
    );

    this.timer = setInterval(() => {
      void this.poll();
    }, env.BLUESKY_POLL_INTERVAL_MS);

    void this.poll();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const feed = await this.source.fetchRecentOwnPosts();
      const ordered = [...feed].reverse();

      for (const feedItem of ordered) {
        const normalized = await normalizeFeedPost({
          feedItem,
          agent: this.source.agent
        });

        if (!normalized) {
          continue;
        }

        if (this.db.hasSeenSourcePost(normalized.sourceUri)) {
          continue;
        }

        await this.queueManager.enqueuePost(normalized, this.targetPlatforms);
        this.db.markSourcePostSeen(normalized.sourceUri, normalized.sourceCid, normalized.createdAt);
        this.log.info(
          {
            sourceUri: normalized.sourceUri,
            targets: this.targetPlatforms,
            mediaCount: normalized.media?.length ?? 0,
            isReply: Boolean(normalized.reply)
          },
          "Queued cross-post jobs for new Bluesky post"
        );
      }

      const now = Date.now();
      if (now - this.lastDeletionSyncAt >= env.BLUESKY_DELETE_SYNC_INTERVAL_MS) {
        await this.syncDeletedPosts();
        this.lastDeletionSyncAt = now;
      }
    } catch (error) {
      this.log.error(
        {
          error: error instanceof Error ? error.message : String(error)
        },
        "Error while polling Bluesky feed"
      );
    } finally {
      this.running = false;
    }
  }

  private async syncDeletedPosts(): Promise<void> {
    const currentUris = await this.source.fetchCurrentPostUris();
    const knownUris = this.db.listActiveSourceUris();
    const deletedUris = knownUris.filter((uri) => !currentUris.has(uri));

    for (const sourceUri of deletedUris) {
      const platformsWithRemotePost = this.db.getPlatformsWithRemoteIds(sourceUri);
      if (platformsWithRemotePost.length > 0) {
        await this.queueManager.enqueueDelete(sourceUri, platformsWithRemotePost);
      }

      this.db.markSourcePostDeleted(sourceUri);
      this.log.info(
        {
          sourceUri,
          targets: platformsWithRemotePost
        },
        "Detected deleted Bluesky post and queued deletion sync"
      );
    }
  }
}
