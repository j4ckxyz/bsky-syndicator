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

      const rootDid = entry?.reply?.root?.author?.did;
      const rootUri = entry?.post?.record?.reply?.root?.uri;

      const isRootOwnPost =
        (typeof rootDid === "string" && rootDid === this.selfDid) ||
        (typeof rootUri === "string" && rootUri.startsWith(`at://${this.selfDid}/`));

      if (isRootOwnPost) {
        return isOwnPost && !isRepost;
      }

      const parentDid = entry?.reply?.parent?.author?.did;
      const parentUri = entry?.post?.record?.reply?.parent?.uri;

      const isParentOwnPost =
        (typeof parentDid === "string" && parentDid === this.selfDid) ||
        (typeof parentUri === "string" && parentUri.startsWith(`at://${this.selfDid}/`));

      return isOwnPost && !isRepost && isParentOwnPost;
    });
  }

  async fetchCurrentPostUris(): Promise<Set<string>> {
    if (!this.selfDid) {
      throw new Error("BlueskySourceAdapter is not initialized");
    }

    const uris = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < env.BLUESKY_DELETE_SYNC_MAX_PAGES; page += 1) {
      const response = await this.agent.com.atproto.repo.listRecords({
        repo: this.selfDid,
        collection: "app.bsky.feed.post",
        limit: 100,
        cursor
      });

      const records = response.data.records ?? [];
      for (const record of records) {
        if (typeof record.uri === "string") {
          uris.add(record.uri);
        }
      }

      cursor = response.data.cursor;
      if (!cursor) {
        break;
      }
    }

    return uris;
  }
}
