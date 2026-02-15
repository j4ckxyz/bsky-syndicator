import { createRestAPIClient } from "masto";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import type { PlatformAdapter } from "./base.js";
import type { CrossPost, PostResult } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import { countByCodePoints, splitIntoThread } from "../core/text-splitter.js";

export class MastodonAdapter implements PlatformAdapter {
  readonly name = "mastodon" as const;
  private readonly log = logger.child({ module: "adapters/mastodon" });
  private readonly db: AppDatabase;
  private client!: ReturnType<typeof createRestAPIClient>;
  private maxCharacters = 500;

  constructor(db: AppDatabase) {
    this.db = db;
  }

  async init(): Promise<void> {
    if (!env.MASTODON_INSTANCE || !env.MASTODON_ACCESS_TOKEN) {
      throw new Error("MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN are required for Mastodon adapter");
    }

    this.client = createRestAPIClient({
      url: env.MASTODON_INSTANCE,
      accessToken: env.MASTODON_ACCESS_TOKEN
    });

    this.maxCharacters = await this.fetchMaxCharacters();

    this.log.info(
      {
        instance: env.MASTODON_INSTANCE,
        maxCharacters: this.maxCharacters
      },
      "Initialized Mastodon adapter"
    );
  }

  private async fetchMaxCharacters(): Promise<number> {
    if (!env.MASTODON_INSTANCE || !env.MASTODON_ACCESS_TOKEN) {
      return 500;
    }

    try {
      const response = await fetch(new URL("/api/v2/instance", env.MASTODON_INSTANCE), {
        headers: {
          Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}`
        }
      });

      if (!response.ok) {
        return 500;
      }

      const payload = (await response.json()) as {
        configuration?: { statuses?: { max_characters?: number } };
      };

      return payload.configuration?.statuses?.max_characters ?? 500;
    } catch {
      return 500;
    }
  }

  private async uploadMedia(post: CrossPost): Promise<string[]> {
    if (!post.media || post.media.length === 0) {
      return [];
    }

    const uploads = post.media.slice(0, 4);
    const mediaIds: string[] = [];

    for (const media of uploads) {
      const fileBytes = Uint8Array.from(media.data);
      const file = new Blob([fileBytes], { type: media.mimeType });
      const uploaded = await this.client.v2.media.create({
        file,
        description: media.altText
      });
      mediaIds.push(uploaded.id);
    }

    return mediaIds;
  }

  async post(post: CrossPost): Promise<PostResult> {
    const chunks = splitIntoThread(post.text, {
      maxLength: this.maxCharacters,
      countLength: countByCodePoints
    });

    const mediaIds = await this.uploadMedia(post);
    const baseReplyId = post.reply
      ? this.db.getPlatformRemoteId(post.reply.parentUri, this.name) ?? undefined
      : undefined;

    let previousId: string | undefined = baseReplyId;
    const threadIds: string[] = [];
    let firstUrl: string | undefined;

    for (let index = 0; index < chunks.length; index += 1) {
      const status = await this.client.v1.statuses.create({
        status: chunks[index],
        mediaIds: index === 0 && mediaIds.length > 0 ? mediaIds : undefined,
        inReplyToId: previousId
      });

      previousId = status.id;
      if (!firstUrl) {
        firstUrl = status.url ?? undefined;
      }
      threadIds.push(status.id);
    }

    return {
      id: threadIds[0],
      url: firstUrl,
      threadIds
    };
  }

  async delete(sourceUri: string): Promise<void> {
    if (!env.MASTODON_INSTANCE || !env.MASTODON_ACCESS_TOKEN) {
      return;
    }

    const remoteIds = this.db.getPlatformRemoteIds(sourceUri, this.name);
    if (remoteIds.length === 0) {
      return;
    }

    for (const remoteId of [...remoteIds].reverse()) {
      const url = new URL(`/api/v1/statuses/${encodeURIComponent(remoteId)}`, env.MASTODON_INSTANCE);
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${env.MASTODON_ACCESS_TOKEN}`
        }
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Mastodon deletion failed (${response.status}): ${response.statusText}`);
      }
    }
  }

  async destroy(): Promise<void> {
    this.log.info("Mastodon adapter stopped");
  }
}
