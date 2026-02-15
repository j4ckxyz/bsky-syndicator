import { AtpAgent } from "@atproto/api";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export class BlueskySourceAdapter {
  private readonly log = logger.child({ module: "adapters/bluesky" });
  readonly agent: AtpAgent;
  private selfDid: string | null = null;

  constructor() {
    this.agent = new AtpAgent({
      service: env.BLUESKY_SERVICE
    });
  }

  async init(): Promise<void> {
    await this.agent.login({
      identifier: env.BLUESKY_IDENTIFIER,
      password: env.BLUESKY_PASSWORD
    });

    const profile = await this.agent.getProfile({
      actor: env.BLUESKY_IDENTIFIER
    });

    this.selfDid = profile.data.did;

    this.log.info(
      {
        service: env.BLUESKY_SERVICE,
        did: this.selfDid
      },
      "Authenticated with Bluesky"
    );
  }

  async fetchRecentOwnPosts(limit = env.BLUESKY_FEED_LIMIT): Promise<any[]> {
    if (!this.selfDid) {
      throw new Error("BlueskySourceAdapter is not initialized");
    }

    const response = await this.agent.getAuthorFeed({
      actor: env.BLUESKY_IDENTIFIER,
      limit
    });

    const feed = response.data.feed ?? [];
    return feed.filter((item) => {
      const isOwnPost = item?.post?.author?.did === this.selfDid;
      const isRepost = Boolean(item?.reason);
      return isOwnPost && !isRepost;
    });
  }
}
