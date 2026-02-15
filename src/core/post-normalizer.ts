import type { AtpAgent } from "@atproto/api";
import type { CrossPost, MediaAsset, QuoteMetadata } from "./types.js";

function normalizeMimeType(value: string | null | undefined): string {
  if (!value) {
    return "application/octet-stream";
  }

  return value.split(";")[0].trim().toLowerCase() || "application/octet-stream";
}

function inferMimeFromFileName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  return null;
}

function inferMimeFromMagic(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 6 && data.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (data.length >= 12 && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }
  return null;
}

function extractQuoteMetadata(embed: any): QuoteMetadata | undefined {
  const recordView =
    embed?.$type === "app.bsky.embed.record#view"
      ? embed?.record
      : embed?.$type === "app.bsky.embed.recordWithMedia#view"
        ? embed?.record?.record
        : undefined;

  if (!recordView || typeof recordView?.uri !== "string") {
    return undefined;
  }

  const value = recordView?.value;
  const text = typeof value?.text === "string" ? value.text : "[Quoted post]";
  const createdAt =
    typeof value?.createdAt === "string"
      ? value.createdAt
      : typeof recordView?.indexedAt === "string"
        ? recordView.indexedAt
        : new Date().toISOString();

  return {
    uri: recordView.uri,
    cid: typeof recordView?.cid === "string" ? recordView.cid : undefined,
    text,
    createdAt,
    authorDid: typeof recordView?.author?.did === "string" ? recordView.author.did : undefined
  };
}

async function fetchBufferFromUrl(url: string): Promise<{ data: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media from ${url}: ${response.status} ${response.statusText}`);
  }

  const mimeType = normalizeMimeType(response.headers.get("content-type"));
  const arrayBuffer = await response.arrayBuffer();
  return {
    data: Buffer.from(arrayBuffer),
    mimeType
  };
}

function extractLinks(record: any, embed: any): string[] {
  const links = new Set<string>();

  const facets = Array.isArray(record?.facets) ? record.facets : [];
  for (const facet of facets) {
    const features = Array.isArray(facet?.features) ? facet.features : [];
    for (const feature of features) {
      if (feature?.$type === "app.bsky.richtext.facet#link" && typeof feature?.uri === "string") {
        links.add(feature.uri);
      }
    }
  }

  if (embed?.$type === "app.bsky.embed.external#view" && typeof embed?.external?.uri === "string") {
    links.add(embed.external.uri);
  }

  return Array.from(links);
}

function blobRefToCid(blobRef: any): string | undefined {
  if (!blobRef) {
    return undefined;
  }

  if (typeof blobRef === "string") {
    return blobRef;
  }

  if (typeof blobRef?.ref?.toString === "function") {
    return blobRef.ref.toString();
  }

  if (typeof blobRef?.ref?.$link === "string") {
    return blobRef.ref.$link;
  }

  if (typeof blobRef?.$link === "string") {
    return blobRef.$link;
  }

  return undefined;
}

async function fetchBlobFromRecord(params: {
  agent: AtpAgent;
  did: string;
  cid: string;
}): Promise<Buffer | null> {
  try {
    const response = await params.agent.com.atproto.sync.getBlob({
      did: params.did,
      cid: params.cid
    });

    const data = (response as any).data;
    if (data instanceof Uint8Array) {
      return Buffer.from(data);
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    if (data?.arrayBuffer) {
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    return null;
  } catch {
    return null;
  }
}

async function extractMedia(feedItem: any, agent: AtpAgent): Promise<MediaAsset[]> {
  const media: MediaAsset[] = [];
  const embedView = feedItem?.post?.embed;
  const mediaView =
    embedView?.$type === "app.bsky.embed.recordWithMedia#view" ? embedView?.media : embedView;
  const record = feedItem?.post?.record;
  const did = feedItem?.post?.author?.did;

  if (mediaView?.$type === "app.bsky.embed.images#view" && Array.isArray(mediaView.images)) {
    for (const image of mediaView.images) {
      if (typeof image?.fullsize !== "string") {
        continue;
      }

      try {
        const downloaded = await fetchBufferFromUrl(image.fullsize);
        const filename = image.fullsize.split("/").pop() ?? "";
        const mimeType =
          downloaded.mimeType.startsWith("image/")
            ? downloaded.mimeType
            : inferMimeFromMagic(downloaded.data) ??
              inferMimeFromFileName(filename) ??
              "image/jpeg";

        media.push({
          type: "image",
          data: downloaded.data,
          mimeType,
          altText: typeof image.alt === "string" ? image.alt : undefined,
          filename: filename || undefined
        });
      } catch {
        continue;
      }
    }
  }

  if (
    record?.embed?.$type === "app.bsky.embed.video" &&
    did &&
    typeof did === "string" &&
    record?.embed?.video
  ) {
    const cid = blobRefToCid(record.embed.video);
    if (cid) {
      const blob = await fetchBlobFromRecord({
        agent,
        did,
        cid
      });

      if (blob) {
        const recordMime = normalizeMimeType(record.embed.video.mimeType);
        const mimeType =
          recordMime.startsWith("video/")
            ? recordMime
            : inferMimeFromMagic(blob) ?? inferMimeFromFileName(`${cid}.mp4`) ?? "video/mp4";

        media.push({
          type: "video",
          data: blob,
          mimeType,
          altText: typeof record.embed.alt === "string" ? record.embed.alt : undefined,
          filename: `${cid}.mp4`
        });
      }
    }
  }

  return media;
}

export async function normalizeFeedPost(params: {
  feedItem: any;
  agent: AtpAgent;
}): Promise<CrossPost | null> {
  const postView = params.feedItem?.post;
  const record = postView?.record;

  if (!postView?.uri || !postView?.cid || !record?.text || typeof postView?.author?.did !== "string") {
    return null;
  }

  const media = await extractMedia(params.feedItem, params.agent);
  const links = extractLinks(record, postView?.embed);
  const altText = media.map((item) => item.altText).filter((item): item is string => Boolean(item));
  const quote = extractQuoteMetadata(postView?.embed);

  const reply =
    record?.reply?.root?.uri &&
    record?.reply?.root?.cid &&
    record?.reply?.parent?.uri &&
    record?.reply?.parent?.cid
      ? {
          rootUri: record.reply.root.uri,
          rootCid: record.reply.root.cid,
          parentUri: record.reply.parent.uri,
          parentCid: record.reply.parent.cid
        }
      : undefined;

  const createdAt =
    typeof record?.createdAt === "string" ? record.createdAt : new Date().toISOString();

  const crossPost: CrossPost = {
    text: String(record.text),
    media: media.length > 0 ? media : undefined,
    links: links.length > 0 ? links : undefined,
    altText: altText.length > 0 ? altText : undefined,
    createdAt,
    authorDid: postView.author.did,
    reply,
    quote,
    sourceUri: postView.uri,
    sourceCid: postView.cid
  };

  return crossPost;
}
