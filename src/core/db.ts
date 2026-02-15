import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PlatformName } from "./types.js";

interface PlatformResultRow {
  remote_id: string | null;
  remote_ids_json: string | null;
}

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

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private ensureColumn(table: string, column: string, columnDef: string): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
    }
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_posts (
        uri TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS platform_results (
        uri TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        remote_id TEXT,
        remote_ids_json TEXT,
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

    this.ensureColumn("source_posts", "deleted_at", "TEXT");
    this.ensureColumn("platform_results", "remote_ids_json", "TEXT");
  }

  hasSeenSourcePost(uri: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM source_posts WHERE uri = ? LIMIT 1")
      .get(uri) as { 1: number } | undefined;
    return Boolean(row);
  }

  listActiveSourceUris(): string[] {
    const rows = this.db
      .prepare("SELECT uri FROM source_posts WHERE deleted_at IS NULL")
      .all() as Array<{ uri: string }>;
    return rows.map((row) => row.uri);
  }

  markSourcePostSeen(uri: string, cid: string, createdAt: string): void {
    this.db
      .prepare(
        `
        INSERT INTO source_posts (uri, cid, created_at, detected_at, deleted_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(uri) DO UPDATE SET
          cid = excluded.cid,
          created_at = excluded.created_at,
          detected_at = excluded.detected_at,
          deleted_at = NULL
      `
      )
      .run(uri, cid, createdAt, new Date().toISOString());
  }

  markSourcePostDeleted(uri: string): void {
    this.db
      .prepare(
        `
        UPDATE source_posts
        SET deleted_at = ?
        WHERE uri = ?
      `
      )
      .run(new Date().toISOString(), uri);
  }

  recordPlatformSuccess(params: {
    uri: string;
    platform: PlatformName;
    remoteId?: string;
    remoteIds?: string[];
    remoteUrl?: string;
  }): void {
    const remoteIds = params.remoteIds?.length
      ? JSON.stringify(Array.from(new Set(params.remoteIds)))
      : null;

    this.db
      .prepare(
        `
        INSERT INTO platform_results (uri, platform, status, remote_id, remote_ids_json, remote_url, error, updated_at)
        VALUES (?, ?, 'success', ?, ?, ?, NULL, ?)
        ON CONFLICT(uri, platform) DO UPDATE SET
          status = excluded.status,
          remote_id = excluded.remote_id,
          remote_ids_json = excluded.remote_ids_json,
          remote_url = excluded.remote_url,
          error = NULL,
          updated_at = excluded.updated_at
      `
      )
      .run(
        params.uri,
        params.platform,
        params.remoteId ?? null,
        remoteIds,
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
        INSERT INTO platform_results (uri, platform, status, remote_id, remote_ids_json, remote_url, error, updated_at)
        VALUES (?, ?, 'failed', NULL, NULL, NULL, ?, ?)
        ON CONFLICT(uri, platform) DO UPDATE SET
          status = excluded.status,
          error = excluded.error,
          updated_at = excluded.updated_at
      `
      )
      .run(params.uri, params.platform, params.error, new Date().toISOString());
  }

  recordPlatformDeletion(params: { uri: string; platform: PlatformName }): void {
    this.db
      .prepare(
        `
        INSERT INTO platform_results (uri, platform, status, remote_id, remote_ids_json, remote_url, error, updated_at)
        VALUES (?, ?, 'deleted', NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(uri, platform) DO UPDATE SET
          status = excluded.status,
          remote_id = NULL,
          remote_ids_json = NULL,
          remote_url = NULL,
          error = NULL,
          updated_at = excluded.updated_at
      `
      )
      .run(params.uri, params.platform, new Date().toISOString());
  }

  getPlatformRemoteIds(uri: string, platform: PlatformName): string[] {
    const row = this.db
      .prepare(
        "SELECT remote_id, remote_ids_json FROM platform_results WHERE uri = ? AND platform = ?"
      )
      .get(uri, platform) as PlatformResultRow | undefined;

    if (!row) {
      return [];
    }

    if (row.remote_ids_json) {
      try {
        const parsed = JSON.parse(row.remote_ids_json) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === "string");
        }
      } catch {
        return row.remote_id ? [row.remote_id] : [];
      }
    }

    return row.remote_id ? [row.remote_id] : [];
  }

  getPlatformRemoteId(uri: string, platform: PlatformName): string | null {
    return this.getPlatformRemoteIds(uri, platform)[0] ?? null;
  }

  getPlatformRemoteUrl(uri: string, platform: PlatformName): string | null {
    const row = this.db
      .prepare("SELECT remote_url FROM platform_results WHERE uri = ? AND platform = ?")
      .get(uri, platform) as { remote_url: string | null } | undefined;
    return row?.remote_url ?? null;
  }

  getPlatformsWithRemoteIds(uri: string): PlatformName[] {
    const rows = this.db
      .prepare(
        `
        SELECT platform
        FROM platform_results
        WHERE uri = ?
          AND status = 'success'
          AND (
            (remote_id IS NOT NULL AND remote_id <> '')
            OR (remote_ids_json IS NOT NULL AND remote_ids_json <> '')
          )
      `
      )
      .all(uri) as Array<{ platform: PlatformName }>;

    return rows.map((row) => row.platform);
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
