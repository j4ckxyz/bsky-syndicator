import { env, platformConfig } from "./config/env.js";
import { logger } from "./config/logger.js";
import { AppDatabase } from "./core/db.js";
import { QueueManager, assertRedisReachable } from "./core/queue.js";
import { BlueskyPoller } from "./core/poller.js";
import { BlueskySourceAdapter } from "./adapters/bluesky.js";
import { MastodonAdapter } from "./adapters/mastodon.js";
import { NostrAdapter } from "./adapters/nostr.js";
import { TwitterAdapter } from "./adapters/twitter.js";
import type { PlatformAdapter } from "./adapters/base.js";
import { CrosspostWorkers } from "./workers/crosspost-worker.js";

async function boot(): Promise<void> {
  const appLogger = logger.child({ module: "index" });
  appLogger.info({ nodeEnv: env.NODE_ENV }, "Starting cross-post service");

  await assertRedisReachable(env.REDIS_URL);

  const db = new AppDatabase(env.DB_PATH);
  const queueManager = new QueueManager(env.REDIS_URL);
  const source = new BlueskySourceAdapter();

  await source.init();

  const adapters: PlatformAdapter[] = [];
  const candidates: Array<{ enabled: boolean; adapter: PlatformAdapter }> = [
    { enabled: platformConfig.mastodonEnabled, adapter: new MastodonAdapter(db) },
    { enabled: platformConfig.nostrEnabled, adapter: new NostrAdapter(db) },
    { enabled: platformConfig.twitterEnabled, adapter: new TwitterAdapter(db) }
  ];

  for (const candidate of candidates) {
    if (!candidate.enabled) {
      continue;
    }

    try {
      await candidate.adapter.init();
      adapters.push(candidate.adapter);
    } catch (error) {
      appLogger.error(
        {
          platform: candidate.adapter.name,
          error: error instanceof Error ? error.message : String(error)
        },
        "Adapter failed to initialize; continuing without this platform"
      );
    }
  }

  if (adapters.length === 0) {
    throw new Error("No target platform adapters initialized. Check environment configuration.");
  }

  const workers = new CrosspostWorkers({
    queueManager,
    db,
    adapters
  });
  workers.start();

  const poller = new BlueskyPoller({
    source,
    db,
    queueManager,
    targetPlatforms: adapters.map((adapter) => adapter.name)
  });
  poller.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    appLogger.info({ signal }, "Shutting down cross-post service");

    await poller.stop();
    await workers.close();
    await Promise.all(adapters.map((adapter) => adapter.destroy()));
    await queueManager.close();
    db.close();

    appLogger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

boot().catch((error) => {
  logger.fatal(
    {
      error: error instanceof Error ? error.message : String(error)
    },
    "Failed to boot cross-post service"
  );
  process.exit(1);
});
