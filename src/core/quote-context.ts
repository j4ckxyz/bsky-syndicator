import { AppDatabase } from "./db.js";
import type { CrossPost, PlatformName } from "./types.js";

function formatQuotedDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function toQuoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join("\n");
}

function resolvePlatformQuoteUrl(params: {
  db: AppDatabase;
  platform: PlatformName;
  sourceUri: string;
}): string | undefined {
  const directUrl = params.db.getPlatformRemoteUrl(params.sourceUri, params.platform);
  if (directUrl) {
    return directUrl;
  }

  const remoteId = params.db.getPlatformRemoteId(params.sourceUri, params.platform);
  if (!remoteId) {
    return undefined;
  }

  if (params.platform === "twitter") {
    return `https://x.com/i/web/status/${remoteId}`;
  }

  if (params.platform === "nostr") {
    return `nostr:${remoteId}`;
  }

  return undefined;
}

function toBlueskyAppPostUrl(uri: string, actorHint?: string): string | undefined {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    return undefined;
  }

  const [, repo, collection, rkey] = match;
  if (collection !== "app.bsky.feed.post") {
    return undefined;
  }

  const actor = actorHint && actorHint.trim() ? actorHint.trim() : repo;
  return `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(rkey)}`;
}

export function buildPostTextWithSelfQuote(params: {
  post: CrossPost;
  platform: PlatformName;
  db: AppDatabase;
}): string {
  const { post } = params;

  if (!post.quote) {
    return post.text;
  }

  const quoteIsSelf =
    (post.quote.authorDid && post.quote.authorDid === post.authorDid) ||
    post.quote.uri.startsWith(`at://${post.authorDid}/`);

  const quoteUrl =
    resolvePlatformQuoteUrl({
      db: params.db,
      platform: params.platform,
      sourceUri: post.quote.uri
    }) ?? toBlueskyAppPostUrl(post.quote.uri, post.quote.authorDid);

  if (!quoteIsSelf) {
    const quoteReference = quoteUrl ? `Quoted post: ${quoteUrl}` : undefined;
    return [post.text.trim(), quoteReference].filter(Boolean).join("\n\n");
  }

  const quoteHeader = `[Quoted ${formatQuotedDate(post.quote.createdAt)}]`;
  const quoteBody = toQuoteBlock(post.quote.text);
  return [post.text.trim(), quoteHeader, quoteBody, quoteUrl].filter(Boolean).join("\n\n");
}
