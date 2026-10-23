import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardRepository } from "../src/dashboard/dashboard-repository";
import { ReadingSessionCoordinator } from "../src/sessions/reading-session-coordinator";
import {
  PaperPetDatabase,
  type PaperPetBackup,
} from "../src/storage/paperpet-database";
import type { ReadingActivitySnapshot } from "../src/model/reading-activity-model";
import type { ReaderItemIdentity } from "../src/tracking/reading-item";

// Exercise the real SQL against SQLite, without opening files or Zotero data.
class MemoryConnection {
  readonly sqlite = new DatabaseSync(":memory:");

  async queryAsync(sql: string, parameters: SQLInputValue[] = []) {
    const statement = this.sqlite.prepare(sql);
    if (statement.columns().length > 0) return statement.all(...parameters);
    statement.run(...parameters);
    return [];
  }

  async valueQueryAsync(sql: string, parameters: SQLInputValue[] = []) {
    const rows = await this.queryAsync(sql, parameters);
    return rows[0] ? Object.values(rows[0])[0] : false;
  }

  async executeTransaction(operation: () => Promise<void>) {
    this.sqlite.exec("BEGIN");
    try {
      await operation();
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async closeDatabase() {
    // Keep the in-memory DB available to simulate reopening after migration.
  }
}

const NOTE: ReaderItemIdentity = {
  libraryID: 1,
  itemKey: "PAPER",
  attachmentKey: "NOTE",
  title: "Paper title",
};
const NOW = new Date(2026, 9, 21, 12).getTime();

function snapshot(effective = 1, editing = 0): ReadingActivitySnapshot {
  return {
    mode: editing > 0 ? "annotating" : "reading",
    confidence: 1,
    foregroundReaderSeconds: effective,
    foregroundDeltaSeconds: effective,
    effectiveReadingSeconds: effective,
    effectiveDeltaSeconds: effective,
    noteEditingSeconds: editing,
    noteEditingDeltaSeconds: editing,
    expectedReadingSeconds: 60,
  };
}

describe("note editing storage and reports", () => {
  let connection: MemoryConnection;
  let database: PaperPetDatabase;
  let repository: DashboardRepository;
  const readJSON = vi.fn();
  const logError = vi.fn();

  beforeEach(() => {
    connection = new MemoryConnection();
    readJSON.mockReset();
    logError.mockReset();
    vi.stubGlobal("PathUtils", {
      join: (...segments: string[]) => segments.join("/"),
      parent: (path: string) => path.slice(0, path.lastIndexOf("/")) || null,
    });
    vi.stubGlobal("IOUtils", { makeDirectory: vi.fn(), readJSON });
    vi.stubGlobal("Services", { uuid: { generateUUID: randomUUID } });
    vi.stubGlobal("Zotero", {
      DBConnection: function () {
        return connection;
      },
      logError,
    });
    database = new PaperPetDatabase("/virtual/paperpet-tests");
    repository = new DashboardRepository(database);
  });

  afterEach(() => {
    connection.sqlite.close();
    vi.unstubAllGlobals();
  });

  async function createSession(startedAt = NOW, editing = 0.75, item = NOTE) {
    const coordinator = new ReadingSessionCoordinator(database);
    await coordinator.initialize();
    coordinator.acceptUpdate({
      observedAt: startedAt,
      item,
      snapshot: snapshot(1, editing),
    });
    const current = coordinator.getCurrentSession();
    await coordinator.shutdown(startedAt + 1_000);
    expect(logError).not.toHaveBeenCalled();
    return current!;
  }

  async function summedEditing(table: string) {
    // Only called with fixed, test-owned table names.
    return connection.valueQueryAsync(
      `SELECT COALESCE(SUM(note_editing_seconds), 0) FROM ${table}`,
    );
  }

  it("creates schema 2 and reopens it without adding columns twice", async () => {
    await database.initialize();
    await database.close();
    await database.initialize();
    expect(
      await connection.valueQueryAsync(
        "SELECT MAX(version) FROM schema_migrations",
      ),
    ).toBe(2);
    for (const table of [
      "reading_sessions",
      "daily_item_stats",
      "item_totals",
    ]) {
      const columns = await connection.queryAsync(
        `PRAGMA table_info(${table})`,
      );
      expect(
        columns.filter((column) => column.name === "note_editing_seconds"),
      ).toHaveLength(1);
    }
  });

  it("adds the metric to schema 1 without rewriting existing time or inventing historical edits", async () => {
    // Minimal legacy fixtures retain the schema-1 columns used by migration and
    // crash recovery. The fresh-install test above exercises the complete schema.
    connection.sqlite.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 1);
      CREATE TABLE reading_sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        foreground_seconds REAL, effective_seconds REAL
      );
      INSERT INTO reading_sessions VALUES ('legacy', 1000, 2000, 90, 75);
      CREATE TABLE daily_item_stats (foreground_seconds REAL, effective_seconds REAL);
      INSERT INTO daily_item_stats VALUES (90, 75);
      CREATE TABLE item_totals (foreground_seconds REAL, effective_seconds REAL);
      INSERT INTO item_totals VALUES (90, 75);
    `);
    await database.initialize();
    expect(
      await connection.valueQueryAsync(
        "SELECT MAX(version) FROM schema_migrations",
      ),
    ).toBe(2);
    for (const table of [
      "reading_sessions",
      "daily_item_stats",
      "item_totals",
    ]) {
      const rows = await connection.queryAsync(`SELECT * FROM ${table}`);
      expect(rows[0]).toMatchObject({
        foreground_seconds: 90,
        effective_seconds: 75,
        note_editing_seconds: 0,
      });
    }
  });

  it("persists fractional editing time across periodic and final flushes without doubling totals", async () => {
    await database.initialize();
    const coordinator = new ReadingSessionCoordinator(database);
    await coordinator.initialize();
    for (let index = 0; index < 32; index += 1) {
      coordinator.acceptUpdate({
        observedAt: NOW + index * 1_000,
        item: NOTE,
        snapshot: snapshot(1, 0.5),
      });
    }
    expect(coordinator.getCurrentSession()).toMatchObject({
      effectiveSeconds: 32,
      noteEditingSeconds: 16,
      annotationCount: 0,
    });
    await coordinator.shutdown(NOW + 33_000);
    expect(logError).not.toHaveBeenCalled();
    for (const table of [
      "reading_sessions",
      "daily_item_stats",
      "item_totals",
    ]) {
      expect(await summedEditing(table)).toBe(16);
      expect(
        await connection.valueQueryAsync(
          `SELECT SUM(effective_seconds) FROM ${table}`,
        ),
      ).toBe(32);
    }
    const overview = await repository.getOverview(7, NOW);
    expect(overview).toMatchObject({
      effectiveSeconds: 32,
      noteEditingSeconds: 16,
      sessionCount: 1,
    });
    expect(overview.daily.at(-1)?.noteEditingSeconds).toBe(16);
    expect(overview.daily[0].noteEditingSeconds).toBe(0);
    expect(overview.recentItems[0].noteEditingSeconds).toBe(16);
    const detail = await repository.getItemDetail(overview.recentItems[0]);
    expect(detail.item.noteEditingSeconds).toBe(16);
    expect(detail.daily[0].noteEditingSeconds).toBe(16);
    expect(detail.sessions[0].noteEditingSeconds).toBe(16);
  });

  it("keeps note and PDF sources separate when switching within one paper", async () => {
    await database.initialize();
    const coordinator = new ReadingSessionCoordinator(database);
    await coordinator.initialize();
    coordinator.acceptUpdate({
      observedAt: NOW,
      item: NOTE,
      snapshot: snapshot(1, 1),
    });
    coordinator.acceptUpdate({
      observedAt: NOW + 1_000,
      item: { ...NOTE, attachmentKey: "PDF" },
      snapshot: snapshot(1, 0),
    });
    await coordinator.shutdown(NOW + 2_000);
    expect(logError).not.toHaveBeenCalled();
    const overview = await repository.getOverview(7, NOW);
    expect(overview).toMatchObject({
      effectiveSeconds: 2,
      noteEditingSeconds: 1,
      sessionCount: 2,
      paperCount: 1,
    });
    expect(
      overview.recentItems.find((item) => item.attachmentKey === "PDF")
        ?.noteEditingSeconds,
    ).toBe(0);
    expect(
      overview.recentItems.find((item) => item.attachmentKey === "NOTE")
        ?.noteEditingSeconds,
    ).toBe(1);
  });

  it("respects date ranges, exclusion and aggregate rebuilding", async () => {
    await database.initialize();
    await createSession(NOW, 0.75);
    await createSession(NOW - 40 * 86_400_000, 0.5);
    const today = await repository.getOverview(7, NOW);
    expect(today.noteEditingSeconds).toBe(0.75);
    expect(today.sessionCount).toBe(1);
    const item = today.recentItems[0];
    const original = await repository.getItemDetail(item);
    expect(original.item.noteEditingSeconds).toBe(1.25);
    const sessionID = original.sessions[0].id;
    await database.excludeSession(sessionID, true);
    expect((await repository.getOverview(7, NOW)).noteEditingSeconds).toBe(0);
    const excluded = await repository.getItemDetail(item);
    expect(excluded.item.noteEditingSeconds).toBe(0.5);
    expect(
      excluded.daily.reduce((sum, day) => sum + day.noteEditingSeconds, 0),
    ).toBe(0.5);
    expect(excluded.sessions[0]).toMatchObject({
      excluded: true,
      noteEditingSeconds: 0.75,
    });
    expect(await summedEditing("item_totals")).toBe(0.5);
    await database.excludeSession(sessionID, false);
    expect((await repository.getOverview(7, NOW)).noteEditingSeconds).toBe(
      0.75,
    );
    expect(await summedEditing("item_totals")).toBe(1.25);
    await database.softDeleteSessions([sessionID]);
    expect((await repository.getItemDetail(item)).item.noteEditingSeconds).toBe(
      0.5,
    );
    expect(await summedEditing("daily_item_stats")).toBe(0.5);
  });

  it.each([1, 2])(
    "imports schema %i reading backups while preserving settings",
    async (version) => {
      await database.initialize();
      await createSession();
      const exported = await database.exportJSON("reading");
      expect(exported.schemaVersion).toBe(2);
      expect(exported.data.reading_sessions[0].note_editing_seconds).toBe(0.75);
      const payload: PaperPetBackup = structuredClone(exported);
      payload.schemaVersion = version;
      if (version === 1) {
        for (const rows of Object.values(payload.data)) {
          for (const row of rows) delete row.note_editing_seconds;
        }
      }
      await database.setSetting("theme", "keep-existing");
      readJSON.mockResolvedValue(payload);
      await database.importBackup("/virtual/reading-backup.json", "reading");
      expect(await database.getSetting("theme")).toBe("keep-existing");
      for (const table of [
        "reading_sessions",
        "daily_item_stats",
        "item_totals",
      ]) {
        expect(await summedEditing(table)).toBe(version === 1 ? 0 : 0.75);
      }
      expect((await repository.getOverview(7, NOW)).noteEditingSeconds).toBe(
        version === 1 ? 0 : 0.75,
      );
    },
  );

  it("restores settings alone without changing editing records", async () => {
    await database.initialize();
    await createSession();
    await database.setSetting("theme", "old");
    const backup = await database.exportJSON("settings");
    expect(backup.data.reading_sessions).toBeUndefined();
    await database.setSetting("theme", "new");
    readJSON.mockResolvedValue(backup);
    await database.importBackup("/virtual/settings-backup.json", "settings");
    expect(await database.getSetting("theme")).toBe("old");
    expect(await summedEditing("reading_sessions")).toBe(0.75);
  });

  it("rejects unsupported backups before changing existing records", async () => {
    await database.initialize();
    await createSession();
    const payload = await database.exportJSON("reading");
    readJSON.mockResolvedValue({ ...payload, schemaVersion: 3 });
    await expect(
      database.importBackup("/virtual/future-backup.json", "reading"),
    ).rejects.toThrow("unsupported schema");
    expect(await summedEditing("reading_sessions")).toBe(0.75);
  });
});
