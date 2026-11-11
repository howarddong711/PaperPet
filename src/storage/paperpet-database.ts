const DATABASE_SCHEMA_VERSION = 3;

import {
  hashSyncPayload,
  type SyncSessionRecord,
  type SyncSemanticEventRecord,
  type SyncSettingRecord,
  type SyncSnapshot,
  validateSyncSnapshot,
} from "../sync/sync-types";

export interface PaperPetBackup {
  format: "paperpet-backup";
  schemaVersion: number;
  exportedAt: number;
  scope?: BackupScope;
  data: Record<string, _ZoteroTypes.anyObj[]>;
}

export type BackupScope = "all" | "reading" | "settings";

const BACKUP_TABLES = [
  "schema_migrations",
  "reading_sessions",
  "semantic_events",
  "daily_item_stats",
  "item_totals",
  "growth_ledger",
  "installed_packs",
  "settings",
] as const;

const MIGRATION_1 = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    attachment_key TEXT NOT NULL,
    title_snapshot TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    timezone TEXT NOT NULL,
    foreground_seconds REAL NOT NULL DEFAULT 0,
    effective_seconds REAL NOT NULL DEFAULT 0,
    annotation_count INTEGER NOT NULL DEFAULT 0,
    excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    model_version INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS reading_sessions_item_time
    ON reading_sessions (library_id, item_key, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS semantic_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES reading_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 1,
    page_index INTEGER,
    metadata_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS semantic_events_session_time
    ON semantic_events (session_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS semantic_events_retention
    ON semantic_events (ended_at)`,
  `CREATE TABLE IF NOT EXISTS daily_item_stats (
    local_date TEXT NOT NULL,
    timezone TEXT NOT NULL,
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    attachment_key TEXT NOT NULL,
    foreground_seconds REAL NOT NULL DEFAULT 0,
    effective_seconds REAL NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    annotation_count INTEGER NOT NULL DEFAULT 0,
    selection_count INTEGER NOT NULL DEFAULT 0,
    search_count INTEGER NOT NULL DEFAULT 0,
    page_coverage_json TEXT,
    PRIMARY KEY (local_date, timezone, library_id, item_key, attachment_key)
  )`,
  `CREATE TABLE IF NOT EXISTS item_totals (
    library_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    attachment_key TEXT NOT NULL,
    title_snapshot TEXT,
    foreground_seconds REAL NOT NULL DEFAULT 0,
    effective_seconds REAL NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    annotation_count INTEGER NOT NULL DEFAULT 0,
    selection_count INTEGER NOT NULL DEFAULT 0,
    search_count INTEGER NOT NULL DEFAULT 0,
    first_read_at INTEGER NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (library_id, item_key, attachment_key)
  )`,
  `CREATE TABLE IF NOT EXISTS growth_ledger (
    id TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    amount REAL NOT NULL,
    source_session_id TEXT REFERENCES reading_sessions(id) ON DELETE SET NULL,
    metadata_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS installed_packs (
    pack_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    author TEXT NOT NULL,
    license TEXT NOT NULL,
    install_path TEXT NOT NULL,
    validation_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    installed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const;

const MIGRATION_2 = [
  "ALTER TABLE reading_sessions ADD COLUMN note_editing_seconds REAL NOT NULL DEFAULT 0",
  "ALTER TABLE daily_item_stats ADD COLUMN note_editing_seconds REAL NOT NULL DEFAULT 0",
  "ALTER TABLE item_totals ADD COLUMN note_editing_seconds REAL NOT NULL DEFAULT 0",
] as const;

const MIGRATION_3 = [
  "ALTER TABLE reading_sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE reading_sessions ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE settings ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''",
] as const;

export interface DatabaseLocation {
  directoryPath: string;
  databasePath: string;
}

export interface InstalledCharacterPackRecord {
  packID: string;
  version: string;
  name: string;
  author: string;
  license: string;
  installPath: string;
  validationJSON: string;
  enabled: boolean;
  installedAt: number;
}

export interface SyncMergeResult {
  sessions: number;
  events: number;
  settings: number;
}

export class PaperPetDatabase {
  private connection?: _ZoteroTypes.DB;

  public readonly location: DatabaseLocation;

  public constructor(dataDirectory = Zotero.DataDirectory.dir) {
    const directoryPath = PathUtils.join(dataDirectory, "paperpet");
    this.location = {
      directoryPath,
      databasePath: PathUtils.join(directoryPath, "paperpet.sqlite"),
    };
  }

  public async initialize(): Promise<void> {
    if (this.connection) {
      return;
    }

    await IOUtils.makeDirectory(this.location.directoryPath, {
      ignoreExisting: true,
    });
    const connection = new Zotero.DBConnection(this.location.databasePath);
    this.connection = connection;
    await connection.queryAsync("PRAGMA foreign_keys = ON");
    await connection.queryAsync("PRAGMA journal_mode = WAL");
    await connection.queryAsync("PRAGMA synchronous = NORMAL");
    await this.migrate(connection);
    await this.recoverInterruptedSessions();
  }

  public get db(): _ZoteroTypes.DB {
    if (!this.connection) {
      throw new Error("PaperPet database is not initialized");
    }
    return this.connection;
  }

  public async getOrCreateDeviceID(): Promise<string> {
    const existing = await this.getSetting<string>("device_id");
    if (existing) {
      return existing;
    }
    const deviceID = createUUID();
    await this.db.queryAsync(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)`,
      ["device_id", JSON.stringify(deviceID), Date.now(), deviceID],
    );
    return deviceID;
  }

  public async getSetting<T>(key: string): Promise<T | undefined> {
    const value = await this.db.valueQueryAsync<string>(
      "SELECT value_json FROM settings WHERE key = ?",
      [key],
    );
    if (typeof value !== "string") {
      return undefined;
    }
    return JSON.parse(value) as T;
  }

  public async setSetting(key: string, value: unknown): Promise<void> {
    const updatedBy =
      key === "device_id" ? String(value) : await this.getOrCreateDeviceID();
    await this.db.queryAsync(
      `INSERT INTO settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [key, JSON.stringify(value), Date.now(), updatedBy],
    );
  }

  public async saveInstalledPack(
    record: InstalledCharacterPackRecord,
  ): Promise<void> {
    await this.db.executeTransaction(async () => {
      if (record.enabled) {
        await this.db.queryAsync("UPDATE installed_packs SET enabled = 0");
      }
      await this.db.queryAsync(
        `INSERT INTO installed_packs (
          pack_id, version, name, author, license, install_path,
          validation_json, enabled, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pack_id) DO UPDATE SET
          version = excluded.version,
          name = excluded.name,
          author = excluded.author,
          license = excluded.license,
          install_path = excluded.install_path,
          validation_json = excluded.validation_json,
          enabled = excluded.enabled,
          installed_at = excluded.installed_at`,
        [
          record.packID,
          record.version,
          record.name,
          record.author,
          record.license,
          record.installPath,
          record.validationJSON,
          record.enabled ? 1 : 0,
          record.installedAt,
        ],
      );
    });
  }

  public async enableInstalledPack(packID: string): Promise<void> {
    await this.db.executeTransaction(async () => {
      const exists = await this.db.valueQueryAsync<number>(
        "SELECT COUNT(*) FROM installed_packs WHERE pack_id = ?",
        [packID],
      );
      if (exists !== 1) {
        throw new Error(`Character pack is not installed: ${packID}`);
      }
      await this.db.queryAsync("UPDATE installed_packs SET enabled = 0");
      await this.db.queryAsync(
        "UPDATE installed_packs SET enabled = 1 WHERE pack_id = ?",
        [packID],
      );
    });
  }

  public async getEnabledPack(): Promise<
    InstalledCharacterPackRecord | undefined
  > {
    const rows = await this.db.queryAsync(
      `SELECT
        pack_id, version, name, author, license, install_path,
        validation_json, enabled, installed_at
        FROM installed_packs WHERE enabled = 1 LIMIT 1`,
    );
    const row = rows?.[0];
    if (!row) {
      return undefined;
    }
    const values = row as Record<string, unknown>;
    return {
      packID: String(values.pack_id),
      version: String(values.version),
      name: String(values.name),
      author: String(values.author),
      license: String(values.license),
      installPath: String(values.install_path),
      validationJSON: String(values.validation_json),
      enabled: Number(values.enabled) === 1,
      installedAt: Number(values.installed_at),
    };
  }

  public async getInstalledPacks(): Promise<InstalledCharacterPackRecord[]> {
    const rows =
      (await this.db.queryAsync(
        `SELECT pack_id, version, name, author, license, install_path,
          validation_json, enabled, installed_at
         FROM installed_packs ORDER BY installed_at DESC, name ASC`,
      )) ?? [];
    return rows.map((row) => mapInstalledPack(row as Record<string, unknown>));
  }

  public async disableInstalledPacks(): Promise<void> {
    await this.db.queryAsync("UPDATE installed_packs SET enabled = 0");
  }

  public async removeInstalledPack(packID: string): Promise<void> {
    await this.db.queryAsync("DELETE FROM installed_packs WHERE pack_id = ?", [
      packID,
    ]);
  }

  public async pruneSemanticEvents(
    now = Date.now(),
    retentionDays = 90,
  ): Promise<number> {
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
    const before = await this.db.valueQueryAsync<number>(
      "SELECT COUNT(*) FROM semantic_events WHERE ended_at < ?",
      [cutoff],
    );
    await this.db.queryAsync("DELETE FROM semantic_events WHERE ended_at < ?", [
      cutoff,
    ]);
    return typeof before === "number" ? before : 0;
  }

  public async softDeleteSessions(
    sessionIDs: readonly string[],
  ): Promise<void> {
    const ids = uniqueNonEmpty(sessionIDs);
    if (ids.length === 0) {
      return;
    }
    await this.db.executeTransaction(async () => {
      const updatedBy = await this.getOrCreateDeviceID();
      for (const id of ids) {
        await this.db.queryAsync(
          "UPDATE reading_sessions SET deleted = 1, updated_at = ?, updated_by = ? WHERE id = ?",
          [Date.now(), updatedBy, id],
        );
      }
      await this.rebuildAggregates();
    });
  }

  public async excludeSession(
    sessionID: string,
    excluded: boolean,
  ): Promise<void> {
    if (!sessionID) {
      return;
    }
    await this.db.executeTransaction(async () => {
      const updatedBy = await this.getOrCreateDeviceID();
      await this.db.queryAsync(
        "UPDATE reading_sessions SET excluded = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted = 0",
        [excluded ? 1 : 0, Date.now(), updatedBy, sessionID],
      );
      await this.rebuildAggregates();
    });
  }

  public async clearAllData(): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.clearAllTables();
    });
  }

  public async exportBackup(
    targetPath: string,
    scope: BackupScope = "all",
  ): Promise<void> {
    const destination = validateBackupPath(targetPath);
    await IOUtils.makeDirectory(PathUtils.parent(destination)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const payload = await this.exportJSON(scope);
    await IOUtils.writeUTF8(destination, JSON.stringify(payload), {
      backupFile: `${destination}.bak`,
      flush: true,
    });
  }

  public async exportJSON(scope: BackupScope = "all"): Promise<PaperPetBackup> {
    const data = {} as PaperPetBackup["data"];
    for (const table of tablesForScope(scope)) {
      data[table] = (await this.db.queryAsync(`SELECT * FROM ${table}`)) ?? [];
    }
    return {
      format: "paperpet-backup",
      schemaVersion: DATABASE_SCHEMA_VERSION,
      exportedAt: Date.now(),
      scope,
      data,
    };
  }

  public async importBackup(
    sourcePath: string,
    requestedScope?: BackupScope,
  ): Promise<void> {
    const source = validateBackupPath(sourcePath);
    const payload = (await IOUtils.readJSON(source)) as unknown;
    if (!isPaperPetBackup(payload)) {
      throw new Error("Invalid PaperPet backup or unsupported schema version");
    }
    await this.db.executeTransaction(async () => {
      const scope = requestedScope ?? payload.scope ?? "all";
      const localDeviceID = scope === "reading" ? undefined : await this.getOrCreateDeviceID();
      await this.clearScope(scope);
      for (const [table, rows] of Object.entries(payload.data)) {
        if (
          !isBackupTable(table) ||
          table === "schema_migrations" ||
          !tablesForScope(scope).includes(
            table as (typeof BACKUP_TABLES)[number],
          )
        ) {
          continue;
        }
        for (const row of rows) {
          const columns = Object.keys(row).filter(isSafeSQLIdentifier);
          if (columns.length === 0) {
            continue;
          }
          const placeholders = columns.map(() => "?").join(", ");
          await this.db.queryAsync(
            `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
            columns.map((column) => row[column] ?? null),
          );
        }
      }
      await this.db.queryAsync(
        "INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [DATABASE_SCHEMA_VERSION, Date.now()],
      );
      if (localDeviceID) {
        await this.db.queryAsync(
          `INSERT OR REPLACE INTO settings (key, value_json, updated_at, updated_by)
           VALUES ('device_id', ?, ?, ?)`,
          [JSON.stringify(localDeviceID), Date.now(), localDeviceID],
        );
      }
    });
  }

  public async exportSyncSnapshot(deviceID: string): Promise<SyncSnapshot> {
    const sessions = (await this.db.queryAsync(
      `SELECT id, device_id, library_id, item_key, attachment_key, title_snapshot,
        started_at, ended_at, timezone, foreground_seconds, effective_seconds,
        note_editing_seconds, annotation_count, excluded, deleted, model_version,
        updated_at, updated_by
       FROM reading_sessions`,
    )) ?? [];
    const events = (await this.db.queryAsync(
      `SELECT id, session_id, event_type, started_at, ended_at, event_count, page_index
       FROM semantic_events`,
    )) ?? [];
    const settings = (await this.db.queryAsync(
      `SELECT key, value_json, updated_at, updated_by FROM settings
       WHERE key = 'user_preferences_v1'`,
    )) ?? [];
    const payload: Omit<SyncSnapshot, "contentHash"> = {
      format: "paperpet-sync",
      schemaVersion: 1,
      exportedAt: Date.now(),
      exportedBy: deviceID,
      sessions: sessions.map((row) => {
        const values = row as Record<string, unknown>;
        return {
          id: String(values.id),
          deviceID: String(values.device_id),
          libraryRef: libraryRefFor(Number(values.library_id)),
          itemKey: String(values.item_key),
          sourceKey: String(values.attachment_key),
          titleSnapshot: String(values.title_snapshot ?? ""),
          startedAt: Number(values.started_at),
          endedAt:
            values.ended_at === null || values.ended_at === undefined
              ? undefined
              : Number(values.ended_at),
          timezone: String(values.timezone),
          foregroundSeconds: Number(values.foreground_seconds ?? 0),
          effectiveSeconds: Number(values.effective_seconds ?? 0),
          noteEditingSeconds: Number(values.note_editing_seconds ?? 0),
          annotationCount: Number(values.annotation_count ?? 0),
          excluded: Number(values.excluded) === 1,
          deleted: Number(values.deleted) === 1,
          modelVersion: Number(values.model_version ?? 1),
          updatedAt: Number(values.updated_at ?? values.started_at),
          updatedBy: String(values.updated_by || values.device_id || deviceID),
        } satisfies SyncSessionRecord;
      }),
      events: events.map((row) => {
        const values = row as Record<string, unknown>;
        return {
          id: String(values.id),
          sessionID: String(values.session_id),
          type: String(values.event_type),
          startedAt: Number(values.started_at),
          endedAt: Number(values.ended_at),
          count: Number(values.event_count ?? 1),
          pageIndex:
            values.page_index === null || values.page_index === undefined
              ? undefined
              : Number(values.page_index),
        } satisfies SyncSemanticEventRecord;
      }),
      settings: settings.map((row) => {
        const values = row as Record<string, unknown>;
        return {
          key: String(values.key),
          valueJSON: syncableSettingsJSON(String(values.value_json)),
          updatedAt: Number(values.updated_at),
          updatedBy: String(values.updated_by ?? ""),
        } satisfies SyncSettingRecord;
      }),
    };
    return {
      ...payload,
      contentHash: hashSyncPayload(payload),
    };
  }

  public async mergeSyncSnapshot(input: unknown): Promise<SyncMergeResult> {
    const snapshot = validateSyncSnapshot(input);
    const result: SyncMergeResult = { sessions: 0, events: 0, settings: 0 };
    await this.db.executeTransaction(async () => {
      for (const session of snapshot.sessions) {
        const libraryID = resolveLibraryID(session.libraryRef);
        if (libraryID === undefined) continue;
        const existing = await this.db.queryAsync(
          "SELECT updated_at, updated_by FROM reading_sessions WHERE id = ?",
          [session.id],
        );
        const current = existing?.[0] as Record<string, unknown> | undefined;
        if (
          current &&
          compareVersion(
            Number(current.updated_at ?? 0),
            String(current.updated_by ?? ""),
            session.updatedAt,
            session.updatedBy,
          ) >= 0
        ) {
          continue;
        }
        await this.db.queryAsync(
          `INSERT INTO reading_sessions (
            id, device_id, library_id, item_key, attachment_key, title_snapshot,
            started_at, ended_at, timezone, foreground_seconds, effective_seconds,
            note_editing_seconds, annotation_count, excluded, deleted, model_version,
            updated_at, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            device_id = excluded.device_id,
            library_id = excluded.library_id,
            item_key = excluded.item_key,
            attachment_key = excluded.attachment_key,
            title_snapshot = excluded.title_snapshot,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            timezone = excluded.timezone,
            foreground_seconds = excluded.foreground_seconds,
            effective_seconds = excluded.effective_seconds,
            note_editing_seconds = excluded.note_editing_seconds,
            annotation_count = excluded.annotation_count,
            excluded = excluded.excluded,
            deleted = excluded.deleted,
            model_version = excluded.model_version,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
          [
            session.id,
            session.deviceID,
            libraryID,
            session.itemKey,
            session.sourceKey,
            session.titleSnapshot,
            session.startedAt,
            session.endedAt ?? null,
            session.timezone,
            session.foregroundSeconds,
            session.effectiveSeconds,
            session.noteEditingSeconds,
            session.annotationCount,
            session.excluded ? 1 : 0,
            session.deleted ? 1 : 0,
            session.modelVersion,
            session.updatedAt,
            session.updatedBy,
          ],
        );
        result.sessions += 1;
      }
      for (const event of snapshot.events) {
        const session = await this.db.valueQueryAsync<number>(
          "SELECT 1 FROM reading_sessions WHERE id = ?",
          [event.sessionID],
        );
        if (Number(session) !== 1) continue;
        const existing = await this.db.valueQueryAsync<number>(
          "SELECT 1 FROM semantic_events WHERE id = ?",
          [event.id],
        );
        if (Number(existing) === 1) continue;
        await this.db.queryAsync(
          `INSERT OR IGNORE INTO semantic_events (
            id, session_id, event_type, started_at, ended_at, event_count, page_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            event.id,
            event.sessionID,
            event.type,
            event.startedAt,
            event.endedAt,
            event.count,
            event.pageIndex ?? null,
          ],
        );
        result.events += 1;
      }
      for (const setting of snapshot.settings) {
        if (setting.key !== "user_preferences_v1") continue;
        const current = await this.db.queryAsync(
          "SELECT value_json, updated_at, updated_by FROM settings WHERE key = ?",
          [setting.key],
        );
        const row = current?.[0] as Record<string, unknown> | undefined;
        if (
          row &&
          compareVersion(
            Number(row.updated_at ?? 0),
            String(row.updated_by ?? ""),
            setting.updatedAt,
            setting.updatedBy,
          ) >= 0
        ) {
          continue;
        }
        await this.db.queryAsync(
          `INSERT INTO settings (key, value_json, updated_at, updated_by)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
          [
            setting.key,
            syncableSettingsJSON(setting.valueJSON),
            setting.updatedAt,
            setting.updatedBy,
          ],
        );
        result.settings += 1;
      }
      if (result.sessions > 0 || result.events > 0) {
        await this.rebuildAggregates();
      }
    });
    return result;
  }

  private async rebuildAggregates(): Promise<void> {
    await this.db.queryAsync("DELETE FROM daily_item_stats");
    await this.db.queryAsync("DELETE FROM item_totals");
    const sessions =
      (await this.db.queryAsync(
        `SELECT * FROM reading_sessions WHERE deleted = 0 AND excluded = 0`,
      )) ?? [];
    for (const row of sessions as _ZoteroTypes.anyObj[]) {
      const values = row as Record<string, unknown>;
      const localDate = localDateFromTimestamp(Number(values.started_at));
      const [selectionCount, searchCount] = await Promise.all([
        this.db.valueQueryAsync<number>(
          "SELECT COALESCE(SUM(event_count), 0) FROM semantic_events WHERE session_id = ? AND event_type = 'selection'",
          [String(values.id)],
        ),
        this.db.valueQueryAsync<number>(
          "SELECT COALESCE(SUM(event_count), 0) FROM semantic_events WHERE session_id = ? AND event_type = 'search'",
          [String(values.id)],
        ),
      ]);
      await this.db.queryAsync(
        `INSERT INTO daily_item_stats (
          local_date, timezone, library_id, item_key, attachment_key,
          foreground_seconds, effective_seconds, note_editing_seconds, session_count, annotation_count,
          selection_count, search_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(local_date, timezone, library_id, item_key, attachment_key)
        DO UPDATE SET
          foreground_seconds = foreground_seconds + excluded.foreground_seconds,
          effective_seconds = effective_seconds + excluded.effective_seconds,
          note_editing_seconds = note_editing_seconds + excluded.note_editing_seconds,
          session_count = session_count + excluded.session_count,
          annotation_count = annotation_count + excluded.annotation_count,
          selection_count = selection_count + excluded.selection_count,
          search_count = search_count + excluded.search_count`,
        [
          localDate,
          String(values.timezone),
          Number(values.library_id),
          String(values.item_key),
          String(values.attachment_key),
          Number(values.foreground_seconds),
          Number(values.effective_seconds),
          Number(values.note_editing_seconds ?? 0),
          Number(values.annotation_count),
          Number(selectionCount ?? 0),
          Number(searchCount ?? 0),
        ],
      );
      await this.db.queryAsync(
        `INSERT INTO item_totals (
          library_id, item_key, attachment_key, title_snapshot,
          foreground_seconds, effective_seconds, note_editing_seconds, session_count,
          annotation_count, selection_count, search_count, first_read_at, last_read_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, item_key, attachment_key) DO UPDATE SET
          foreground_seconds = foreground_seconds + excluded.foreground_seconds,
          effective_seconds = effective_seconds + excluded.effective_seconds,
          note_editing_seconds = note_editing_seconds + excluded.note_editing_seconds,
          session_count = session_count + excluded.session_count,
          annotation_count = annotation_count + excluded.annotation_count,
          selection_count = selection_count + excluded.selection_count,
          search_count = search_count + excluded.search_count,
          first_read_at = MIN(first_read_at, excluded.first_read_at),
          last_read_at = MAX(last_read_at, excluded.last_read_at)`,
        [
          Number(values.library_id),
          String(values.item_key),
          String(values.attachment_key),
          String(values.title_snapshot ?? ""),
          Number(values.foreground_seconds),
          Number(values.effective_seconds),
          Number(values.note_editing_seconds ?? 0),
          Number(values.annotation_count),
          Number(selectionCount ?? 0),
          Number(searchCount ?? 0),
          Number(values.started_at),
          Number(values.ended_at ?? values.started_at),
        ],
      );
    }
  }

  private async clearAllTables(includePreferences = false): Promise<void> {
    const tables = [
      "semantic_events",
      "reading_sessions",
      "daily_item_stats",
      "item_totals",
      "growth_ledger",
    ];
    if (includePreferences) {
      tables.push("installed_packs", "settings");
    }
    for (const table of tables) {
      await this.db.queryAsync(`DELETE FROM ${table}`);
    }
  }

  private async clearScope(scope: BackupScope): Promise<void> {
    const tables = tablesForScope(scope).filter(
      (table) => table !== "schema_migrations",
    );
    for (const table of tables) {
      await this.db.queryAsync(`DELETE FROM ${table}`);
    }
  }

  public async recoverInterruptedSessions(): Promise<number> {
    const interrupted = await this.db.valueQueryAsync<number>(
      "SELECT COUNT(*) FROM reading_sessions WHERE ended_at IS NULL",
    );
    await this.db.queryAsync(
      `UPDATE reading_sessions
       SET ended_at = started_at + CAST(foreground_seconds * 1000 AS INTEGER)
       WHERE ended_at IS NULL`,
    );
    return typeof interrupted === "number" ? interrupted : 0;
  }

  public async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    const connection = this.connection;
    this.connection = undefined;
    await connection.closeDatabase(true);
  }

  private async migrate(connection: _ZoteroTypes.DB): Promise<void> {
    await connection.queryAsync(MIGRATION_1[0]);
    const current = await connection.valueQueryAsync<number>(
      "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
    );
    const currentVersion = typeof current === "number" ? current : 0;
    if (currentVersion > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `PaperPet database schema ${currentVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
      );
    }
    const migrations = [MIGRATION_1.slice(1), MIGRATION_2, MIGRATION_3];
    for (let index = currentVersion; index < migrations.length; index += 1) {
      await connection.executeTransaction(async () => {
        for (const statement of migrations[index]) {
          await connection.queryAsync(statement);
        }
        await connection.queryAsync(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
          [index + 1, Date.now()],
        );
      });
    }
  }
}

export function createUUID(): string {
  return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mapInstalledPack(
  values: Record<string, unknown>,
): InstalledCharacterPackRecord {
  return {
    packID: String(values.pack_id),
    version: String(values.version),
    name: String(values.name),
    author: String(values.author),
    license: String(values.license),
    installPath: String(values.install_path),
    validationJSON: String(values.validation_json),
    enabled: Number(values.enabled) === 1,
    installedAt: Number(values.installed_at),
  };
}

function tablesForScope(
  scope: BackupScope,
): readonly (typeof BACKUP_TABLES)[number][] {
  if (scope === "reading") {
    return [
      "reading_sessions",
      "semantic_events",
      "daily_item_stats",
      "item_totals",
      "growth_ledger",
    ];
  }
  if (scope === "settings") {
    return ["installed_packs", "settings"];
  }
  return BACKUP_TABLES;
}

function validateBackupPath(path: string): string {
  if (
    !path ||
    !path.toLowerCase().endsWith(".json") ||
    path.includes("\0") ||
    PathUtils.parent(path) === null
  ) {
    throw new Error("Backup path must be an absolute .json file path");
  }
  return path;
}

function localDateFromTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function libraryRefFor(libraryID: number): string {
  try {
    const type = Zotero.Libraries.getType(libraryID);
    if (type === "group") {
      const library = Zotero.Libraries.get(libraryID) as
        | (Zotero.Library & { groupID?: number })
        | false;
      if (library && library.groupID) return `group:${library.groupID}`;
    }
    if (type === "user") return "user";
  } catch {
    // Unit tests and an early Zotero startup can lack library metadata.
  }
  return `local:${libraryID}`;
}

function resolveLibraryID(libraryRef: string): number | undefined {
  if (libraryRef === "user") {
    return Zotero.Libraries.userLibraryID;
  }
  if (libraryRef.startsWith("group:")) {
    const groupID = Number(libraryRef.slice("group:".length));
    for (const library of Zotero.Libraries.getAll()) {
      const candidate = library as Zotero.Library & { groupID?: number };
      if (candidate.groupID === groupID) return candidate.libraryID;
    }
    return undefined;
  }
  if (libraryRef.startsWith("local:")) {
    const libraryID = Number(libraryRef.slice("local:".length));
    return Number.isFinite(libraryID) ? libraryID : undefined;
  }
  return undefined;
}

function compareVersion(
  localUpdatedAt: number,
  localUpdatedBy: string,
  remoteUpdatedAt: number,
  remoteUpdatedBy: string,
): number {
  return (
    localUpdatedAt - remoteUpdatedAt ||
    localUpdatedBy.localeCompare(remoteUpdatedBy)
  );
}

function syncableSettingsJSON(valueJSON: string): string {
  const values = JSON.parse(valueJSON) as unknown;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("PaperPet sync settings are invalid");
  }
  const { syncEnabled: _localOnly, ...syncable } = values as Record<string, unknown>;
  return JSON.stringify(syncable);
}

function isPaperPetBackup(value: unknown): value is PaperPetBackup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PaperPetBackup>;
  return (
    candidate.format === "paperpet-backup" &&
    Number.isInteger(candidate.schemaVersion) &&
    Number(candidate.schemaVersion) >= 1 &&
    Number(candidate.schemaVersion) <= DATABASE_SCHEMA_VERSION &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    (candidate.scope === undefined ||
      candidate.scope === "all" ||
      candidate.scope === "reading" ||
      candidate.scope === "settings") &&
    Object.entries(candidate.data).every(
      ([table, rows]) =>
        isBackupTable(table) &&
        Array.isArray(rows) &&
        rows.every((row) => Boolean(row) && typeof row === "object"),
    )
  );
}

function isBackupTable(value: string): value is (typeof BACKUP_TABLES)[number] {
  return (BACKUP_TABLES as readonly string[]).includes(value);
}

function isSafeSQLIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
