const DATABASE_SCHEMA_VERSION = 1;

export interface PaperPetBackup {
  format: "paperpet-backup";
  schemaVersion: number;
  exportedAt: number;
  data: Record<string, _ZoteroTypes.anyObj[]>;
}

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
    await this.setSetting("device_id", deviceID);
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
    await this.db.queryAsync(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), Date.now()],
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
      for (const id of ids) {
        await this.db.queryAsync(
          "UPDATE reading_sessions SET deleted = 1 WHERE id = ?",
          [id],
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
      await this.db.queryAsync(
        "UPDATE reading_sessions SET excluded = ? WHERE id = ? AND deleted = 0",
        [excluded ? 1 : 0, sessionID],
      );
      await this.rebuildAggregates();
    });
  }

  public async clearAllData(): Promise<void> {
    await this.db.executeTransaction(async () => {
      await this.clearAllTables();
    });
  }

  public async exportBackup(targetPath: string): Promise<void> {
    const destination = validateBackupPath(targetPath);
    await IOUtils.makeDirectory(PathUtils.parent(destination)!, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const payload = await this.exportJSON();
    await IOUtils.writeUTF8(destination, JSON.stringify(payload), {
      backupFile: `${destination}.bak`,
      flush: true,
    });
  }

  public async exportJSON(): Promise<PaperPetBackup> {
    const data = {} as PaperPetBackup["data"];
    for (const table of BACKUP_TABLES) {
      data[table] = (await this.db.queryAsync(`SELECT * FROM ${table}`)) ?? [];
    }
    return {
      format: "paperpet-backup",
      schemaVersion: DATABASE_SCHEMA_VERSION,
      exportedAt: Date.now(),
      data,
    };
  }

  public async importBackup(sourcePath: string): Promise<void> {
    const source = validateBackupPath(sourcePath);
    const payload = (await IOUtils.readJSON(source)) as unknown;
    if (!isPaperPetBackup(payload)) {
      throw new Error("Invalid PaperPet backup or unsupported schema version");
    }
    await this.db.executeTransaction(async () => {
      await this.clearAllTables(true);
      for (const [table, rows] of Object.entries(payload.data)) {
        if (!isBackupTable(table) || table === "schema_migrations") {
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
    });
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
          foreground_seconds, effective_seconds, session_count, annotation_count,
          selection_count, search_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(local_date, timezone, library_id, item_key, attachment_key)
        DO UPDATE SET
          foreground_seconds = foreground_seconds + excluded.foreground_seconds,
          effective_seconds = effective_seconds + excluded.effective_seconds,
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
          Number(values.annotation_count),
          Number(selectionCount ?? 0),
          Number(searchCount ?? 0),
        ],
      );
      await this.db.queryAsync(
        `INSERT INTO item_totals (
          library_id, item_key, attachment_key, title_snapshot,
          foreground_seconds, effective_seconds, session_count,
          annotation_count, selection_count, search_count, first_read_at, last_read_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(library_id, item_key, attachment_key) DO UPDATE SET
          foreground_seconds = foreground_seconds + excluded.foreground_seconds,
          effective_seconds = effective_seconds + excluded.effective_seconds,
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
    if (currentVersion >= 1) {
      return;
    }

    await connection.executeTransaction(async () => {
      for (const statement of MIGRATION_1.slice(1)) {
        await connection.queryAsync(statement);
      }
      await connection.queryAsync(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [1, Date.now()],
      );
    });
  }
}

export function createUUID(): string {
  return Services.uuid.generateUUID().toString().replace(/[{}]/g, "");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

function isPaperPetBackup(value: unknown): value is PaperPetBackup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PaperPetBackup>;
  return (
    candidate.format === "paperpet-backup" &&
    candidate.schemaVersion === DATABASE_SCHEMA_VERSION &&
    typeof candidate.data === "object" &&
    candidate.data !== null &&
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
