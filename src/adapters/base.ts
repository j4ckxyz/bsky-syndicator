import type { CrossPost, PlatformName, PostResult } from "../core/types.js";

export interface PlatformAdapter {
  readonly name: PlatformName;
  init(): Promise<void>;
  post(post: CrossPost): Promise<PostResult>;
  delete(sourceUri: string): Promise<void>;
  destroy(): Promise<void>;
}
