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

export interface QuoteMetadata {
  uri: string;
  cid?: string;
  text: string;
  createdAt: string;
  authorDid?: string;
}

export interface CrossPost {
  text: string;
  media?: MediaAsset[];
  links?: string[];
  altText?: string[];
  createdAt: string;
  authorDid: string;
  reply?: ReplyMetadata;
  quote?: QuoteMetadata;
  sourceUri: string;
  sourceCid: string;
}

export interface MediaAssetWire extends Omit<MediaAsset, "data"> {
  dataBase64: string;
}

export interface CrossPostWire extends Omit<CrossPost, "media"> {
  media?: MediaAssetWire[];
}

export interface PostResult {
  id: string;
  url?: string;
  threadIds?: string[];
}

export interface CrossPostPublishJobData {
  platform: PlatformName;
  action: "post";
  post: CrossPost | CrossPostWire;
}

export interface CrossPostDeleteJobData {
  platform: PlatformName;
  action: "delete";
  sourceUri: string;
}

export type CrossPostJobData = CrossPostPublishJobData | CrossPostDeleteJobData;

export interface SourceRecord {
  uri: string;
  cid: string;
  createdAt: string;
}
