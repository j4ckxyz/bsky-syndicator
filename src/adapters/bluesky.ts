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
      const entry = item as any;

      const isOwnPost = entry?.post?.author?.did === this.selfDid;
      const isRepost = Boolean(entry?.reason);

      const hasReplyParent =
        Boolean(entry?.reply?.parent) ||
        typeof entry?.post?.record?.reply?.parent?.uri === "string";

      if (!hasReplyParent) {
        return isOwnPost && !isRepost;
      }

      const parentDid = entry?.reply?.parent?.author?.did;
      const parentUri = entry?.post?.record?.reply?.parent?.uri;

      const isReplyToOwnPost =
        (typeof parentDid === "string" && parentDid === this.selfDid) ||
        (typeof parentUri === "string" && parentUri.startsWith(`at://${this.selfDid}/`));

      return isOwnPost && !isRepost && isReplyToOwnPost;
    });
  }
}
