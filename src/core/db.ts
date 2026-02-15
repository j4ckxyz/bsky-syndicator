import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PlatformName } from "./types.js";

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_posts (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        detected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_results (
        uri TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        remote_id TEXT,
        remote_url TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (uri, platform)
      );

      CREATE TABLE IF NOT EXISTS twitter_budget (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  hasSeenSourcePost(uri: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM source_posts WHERE uri = ? LIMIT 1")
      .get(uri) as { 1: number } | undefined;
    return Boolean(row);
  }

  markSourcePostSeen(uri: string, cid: string, createdAt: string): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO source_posts (uri, cid, created_at, detected_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(uri, cid, createdAt, new Date().toISOString());
  }

  recordPlatformSuccess(params: {
    uri: string;
    platform: PlatformName;
    remoteId?: string;
    remoteUrl?: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO platform_results (uri, platform, status, remote_id, remote_url, error, updated_at)
        VALUES (?, ?, 'success', ?, ?, NULL, ?)
        ON CONFLICT(uri, platform) DO UPDATE SET
          status = excluded.status,
          remote_id = excluded.remote_id,
          remote_url = excluded.remote_url,
          error = NULL,
          updated_at = excluded.updated_at
      `
      )
      .run(
        params.uri,
        params.platform,
        params.remoteId ?? null,
        params.remoteUrl ?? null,
        new Date().toISOString()
      );
  }

  recordPlatformFailure(params: {
    uri: string;
    platform: PlatformName;
    error: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO platform_results (uri, platform, status, remote_id, remote_url, error, updated_at)
        VALUES (?, ?, 'failed', NULL, NULL, ?, ?)
        ON CONFLICT(uri, platform) DO UPDATE SET
          status = excluded.status,
          error = excluded.error,
          updated_at = excluded.updated_at
      `
      )
      .run(params.uri, params.platform, params.error, new Date().toISOString());
  }

  getPlatformRemoteId(uri: string, platform: PlatformName): string | null {
    const row = this.db
      .prepare("SELECT remote_id FROM platform_results WHERE uri = ? AND platform = ?")
      .get(uri, platform) as { remote_id: string | null } | undefined;
    return row?.remote_id ?? null;
  }

  getPlatformRemoteUrl(uri: string, platform: PlatformName): string | null {
    const row = this.db
      .prepare("SELECT remote_url FROM platform_results WHERE uri = ? AND platform = ?")
      .get(uri, platform) as { remote_url: string | null } | undefined;
    return row?.remote_url ?? null;
  }

  getTwitterPostCount(day: string): number {
    const row = this.db
      .prepare("SELECT count FROM twitter_budget WHERE day = ?")
      .get(day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  incrementTwitterPostCount(day: string, incrementBy = 1): number {
    this.db
      .prepare(
        `
        INSERT INTO twitter_budget (day, count)
        VALUES (?, ?)
        ON CONFLICT(day) DO UPDATE SET count = count + excluded.count
      `
      )
      .run(day, incrementBy);

    return this.getTwitterPostCount(day);
  }

  close(): void {
    this.db.close();
  }
}
