import type { AtpAgent } from "@atproto/api";
import type { CrossPost, MediaAsset } from "./types.js";

async function fetchBufferFromUrl(url: string): Promise<{ data: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download media from ${url}: ${response.status} ${response.statusText}`);
  }

  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
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
  const record = feedItem?.post?.record;
  const did = feedItem?.post?.author?.did;

  if (embedView?.$type === "app.bsky.embed.images#view" && Array.isArray(embedView.images)) {
    for (const image of embedView.images) {
      if (typeof image?.fullsize !== "string") {
        continue;
      }

      try {
        const downloaded = await fetchBufferFromUrl(image.fullsize);
        media.push({
          type: "image",
          data: downloaded.data,
          mimeType: downloaded.mimeType,
          altText: typeof image.alt === "string" ? image.alt : undefined,
          filename: image.fullsize.split("/").pop() ?? undefined
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
        media.push({
          type: "video",
          data: blob,
          mimeType: record.embed.video.mimeType ?? "video/mp4",
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

  if (!postView?.uri || !postView?.cid || !record?.text) {
    return null;
  }

  const media = await extractMedia(params.feedItem, params.agent);
  const links = extractLinks(record, postView?.embed);
  const altText = media.map((item) => item.altText).filter((item): item is string => Boolean(item));

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
    reply,
    sourceUri: postView.uri,
    sourceCid: postView.cid
  };

  return crossPost;
}
