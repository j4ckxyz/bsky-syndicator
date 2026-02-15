export type PlatformName = "mastodon" | "nostr" | "twitter";

export type MediaType = "image" | "video";

export interface MediaAsset {
  type: MediaType;
  data: Buffer;
  mimeType: string;
  altText?: string;
  filename?: string;
}

export interface ReplyMetadata {
  rootUri: string;
  rootCid: string;
  parentUri: string;
  parentCid: string;
}

export interface CrossPost {
  text: string;
  media?: MediaAsset[];
  links?: string[];
  altText?: string[];
  createdAt: string;
  reply?: ReplyMetadata;
  sourceUri: string;
  sourceCid: string;
}

export interface PostResult {
  id: string;
  url?: string;
  threadIds?: string[];
}

export interface CrossPostJobData {
  platform: PlatformName;
  post: CrossPost;
}

export interface SourceRecord {
  uri: string;
  cid: string;
  createdAt: string;
}
