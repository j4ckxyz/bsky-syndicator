import type { CrossPost, CrossPostWire } from "./types.js";

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    return Buffer.from(value, "base64");
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }

  if (value && typeof value === "object") {
    const maybeBuffer = value as { type?: unknown; data?: unknown };
    if (maybeBuffer.type === "Buffer" && Array.isArray(maybeBuffer.data)) {
      return Buffer.from(maybeBuffer.data as number[]);
    }
  }

  throw new Error("Unsupported media payload format in queue job");
}

export function encodePostForQueue(post: CrossPost): CrossPostWire {
  return {
    ...post,
    media: post.media?.map((media) => ({
      type: media.type,
      dataBase64: media.data.toString("base64"),
      mimeType: media.mimeType,
      altText: media.altText,
      filename: media.filename
    }))
  };
}

export function decodePostFromQueue(post: CrossPost | CrossPostWire): CrossPost {
  const wire = post as CrossPostWire;

  const media = wire.media?.map((entry) => {
    const fallback = entry as unknown as { data?: unknown };
    const raw = "dataBase64" in entry ? entry.dataBase64 : fallback.data;

    return {
      type: entry.type,
      data: asBuffer(raw),
      mimeType: entry.mimeType,
      altText: entry.altText,
      filename: entry.filename
    };
  });

  return {
    text: wire.text,
    media,
    links: wire.links,
    altText: wire.altText,
    createdAt: wire.createdAt,
    reply: wire.reply,
    sourceUri: wire.sourceUri,
    sourceCid: wire.sourceCid
  };
}
