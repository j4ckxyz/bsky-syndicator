import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { PlatformAdapter } from "./base.js";
import type { CrossPost, PostResult } from "../core/types.js";
import { AppDatabase } from "../core/db.js";
import { buildPostTextWithSelfQuote } from "../core/quote-context.js";

interface UploadedMedia {
  url: string;
  altText?: string;
}

function parsePrivateKey(value: string): Uint8Array {
  if (value.startsWith("nsec")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") {
      throw new Error("NOSTR_PRIVATE_KEY is not a valid nsec value");
    }
    return decoded.data;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("NOSTR_PRIVATE_KEY must be a 32-byte hex value or nsec");
  }

  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export class NostrAdapter implements PlatformAdapter {
  readonly name = "nostr" as const;
  private readonly log = logger.child({ module: "adapters/nostr" });
  private readonly db: AppDatabase;
  private readonly relays = env.nostrRelays;

  private pool: SimplePool;
  private secretKey!: Uint8Array;
  private publicKey!: string;
  private mediaUploadUrl: string | null = null;

  constructor(db: AppDatabase) {
    this.db = db;
    useWebSocketImplementation(WebSocket);
    this.pool = new SimplePool({
      enableReconnect: true,
      enablePing: true
    });
  }

  async init(): Promise<void> {
    if (!env.NOSTR_PRIVATE_KEY) {
      throw new Error("NOSTR_PRIVATE_KEY is required for Nostr adapter");
    }

    this.secretKey = parsePrivateKey(env.NOSTR_PRIVATE_KEY);
    this.publicKey = getPublicKey(this.secretKey);

    this.mediaUploadUrl = await this.discoverNip96UploadUrl();

    this.log.info(
      {
        pubkey: this.publicKey,
        relayCount: this.relays.length,
        mediaUploadUrl: this.mediaUploadUrl
      },
      "Initialized Nostr adapter"
    );
  }

  private async discoverNip96UploadUrl(): Promise<string | null> {
    try {
      const host = env.NOSTR_MEDIA_HOST.replace(/\/$/, "");
      const response = await fetch(`${host}/.well-known/nostr/nip96.json`);
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as { api_url?: string };
      return payload.api_url ?? null;
    } catch {
      return null;
    }
  }

  private createNip98AuthHeader(url: string, method: string, payloadHash?: string): string {
    const tags: string[][] = [
      ["u", url],
      ["method", method.toUpperCase()]
    ];

    if (payloadHash) {
      tags.push(["payload", payloadHash]);
    }

    const authEvent = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ""
      },
      this.secretKey
    );

    const encoded = Buffer.from(JSON.stringify(authEvent)).toString("base64");
    return `Nostr ${encoded}`;
  }

  private async uploadMedia(post: CrossPost): Promise<UploadedMedia[]> {
    if (!this.mediaUploadUrl || !post.media || post.media.length === 0) {
      return [];
    }

    const uploaded: UploadedMedia[] = [];

    for (const media of post.media) {
      const form = new FormData();
      const filename = media.filename ?? `${Date.now()}.${media.type === "image" ? "jpg" : "mp4"}`;
      const fileBytes = Uint8Array.from(media.data);
      form.set("file", new Blob([fileBytes], { type: media.mimeType }), filename);
      if (media.altText) {
        form.set("alt", media.altText);
      }

      const payloadHash = createHash("sha256").update(media.data).digest("hex");

      const response = await fetch(this.mediaUploadUrl, {
        method: "POST",
        headers: {
          Authorization: this.createNip98AuthHeader(this.mediaUploadUrl, "POST", payloadHash)
        },
        body: form
      });

      if (!response.ok) {
        throw new Error(`nostr.build upload failed: ${response.status} ${response.statusText}`);
      }

      const payload = (await response.json()) as {
        nip94_event?: { tags?: Array<[string, string]> };
      };

      const tags = payload.nip94_event?.tags ?? [];
      const urlTag = tags.find((tag) => tag[0] === "url");
      if (!urlTag?.[1]) {
        throw new Error("nostr.build upload response missing URL tag");
      }

      uploaded.push({
        url: urlTag[1],
        altText: media.altText
      });
    }

    return uploaded;
  }

  async post(post: CrossPost): Promise<PostResult> {
    const uploadedMedia = await this.uploadMedia(post);

    const text = buildPostTextWithSelfQuote({
      post,
      platform: this.name,
      db: this.db
    });

    const mediaLines = uploadedMedia.map((item) => item.url);
    const altLines = uploadedMedia
      .map((item, index) => (item.altText ? `[alt ${index + 1}] ${item.altText}` : null))
      .filter((item): item is string => Boolean(item));

    const contentBlocks = [text.trim()];
    if (mediaLines.length > 0) {
      contentBlocks.push(mediaLines.join("\n"));
    }
    if (altLines.length > 0) {
      contentBlocks.push(altLines.join("\n"));
    }

    const tags: string[][] = [];
    if (post.altText && post.altText.length > 0) {
      tags.push(["alt", post.altText.join(" | ")]);
    }

    if (post.reply?.rootUri) {
      const rootId = this.db.getPlatformRemoteId(post.reply.rootUri, this.name);
      const parentId = this.db.getPlatformRemoteId(post.reply.parentUri, this.name);

      if (!rootId && !parentId) {
        throw new Error(
          `Reply thread dependency not ready on Nostr for ${post.sourceUri}; waiting for parent/root cross-post`
        );
      }

      if (rootId) {
        tags.push(["e", rootId, "", "root"]);
      }
      if (parentId || rootId) {
        tags.push(["e", parentId ?? rootId!, "", "reply"]);
      }
      if (rootId || parentId) {
        tags.push(["p", this.publicKey]);
      }
    }

    const event = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(new Date(post.createdAt).getTime() / 1000),
        tags,
        content: contentBlocks.filter(Boolean).join("\n\n")
      },
      this.secretKey
    );

    const publishResults = this.pool.publish(this.relays, event) as Array<Promise<unknown>>;
    await Promise.any(publishResults);

    return {
      id: event.id,
      url: `nostr:${event.id}`,
      threadIds: [event.id]
    };
  }

  async delete(sourceUri: string): Promise<void> {
    const remoteIds = this.db.getPlatformRemoteIds(sourceUri, this.name);
    if (remoteIds.length === 0) {
      return;
    }

    for (const remoteId of remoteIds) {
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["e", remoteId]],
          content: "Deleted from source"
        },
        this.secretKey
      );

      const publishResults = this.pool.publish(this.relays, deletion) as Array<Promise<unknown>>;
      await Promise.any(publishResults);
    }
  }

  async destroy(): Promise<void> {
    this.pool.close(this.relays);
    this.log.info("Nostr adapter stopped");
  }
}
