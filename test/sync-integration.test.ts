import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperPetDatabase } from "../src/storage/paperpet-database";
import { DashboardRepository } from "../src/dashboard/dashboard-repository";
import {
  DEFAULT_PAPERPET_SETTINGS,
  PaperPetSettingsStore,
} from "../src/settings/paperpet-settings";
import { PaperPetSyncCoordinator } from "../src/sync/sync-coordinator";
import type { SyncCarrier, SyncSnapshot } from "../src/sync/sync-types";

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

  async closeDatabase() {}
}

function makeCarrier(notes: Map<string, SyncSnapshot>): SyncCarrier {
  return {
    readAll: async () =>
      [...notes.values()].map((snapshot) => structuredClone(snapshot)),
    readOwn: async (deviceID) => {
      const snapshot = notes.get(deviceID);
      return snapshot ? structuredClone(snapshot) : undefined;
    },
    write: async (deviceID, snapshot) => {
      notes.set(deviceID, structuredClone(snapshot));
    },
  };
}

function exchange(
  left: Map<string, SyncSnapshot>,
  right: Map<string, SyncSnapshot>,
): void {
  for (const [deviceID, snapshot] of left) {
    if (
      !right.has(deviceID) ||
      right.get(deviceID)!.exportedAt < snapshot.exportedAt
    ) {
      right.set(deviceID, structuredClone(snapshot));
    }
  }
  for (const [deviceID, snapshot] of right) {
    if (
      !left.has(deviceID) ||
      left.get(deviceID)!.exportedAt < snapshot.exportedAt
    ) {
      left.set(deviceID, structuredClone(snapshot));
    }
  }
}

describe("two-device PaperPet sync", () => {
  const connections = new Map<string, MemoryConnection>();

  afterEach(() => {
    for (const connection of connections.values()) connection.sqlite.close();
    connections.clear();
    vi.unstubAllGlobals();
  });

  it("adds independent sessions, stays idempotent, and propagates exclusion", async () => {
    vi.stubGlobal("PathUtils", {
      join: (...parts: string[]) => parts.join("/"),
    });
    vi.stubGlobal("IOUtils", { makeDirectory: vi.fn() });
    vi.stubGlobal("Zotero", {
      DataDirectory: { dir: "/virtual" },
      DBConnection: function (path: string) {
        const connection = new MemoryConnection();
        connections.set(path, connection);
        return connection;
      },
      Libraries: { userLibraryID: 1, getType: () => "user" },
      Notifier: {
        registerObserver: () => "observer",
        unregisterObserver: vi.fn(),
      },
      getMainWindows: () => [
        {
          setTimeout: () => 1,
          clearTimeout: vi.fn(),
          setInterval: () => 2,
          clearInterval: vi.fn(),
        },
      ],
      logError: vi.fn(),
    });

    const first = new PaperPetDatabase("/virtual/first");
    const second = new PaperPetDatabase("/virtual/second");
    await first.initialize();
    await second.initialize();
    await first.setSetting("device_id", "device-a");
    await second.setSetting("device_id", "device-b");
    const firstSettings = new PaperPetSettingsStore(first);
    const secondSettings = new PaperPetSettingsStore(second);
    await firstSettings.save({
      ...DEFAULT_PAPERPET_SETTINGS,
      petSize: 140,
      syncEnabled: true,
    });
    await secondSettings.save({
      ...DEFAULT_PAPERPET_SETTINGS,
      syncEnabled: true,
    });
    for (const [database, id, deviceID, seconds] of [
      [first, "session-a", "device-a", 30],
      [second, "session-b", "device-b", 40],
    ] as const) {
      await database.db.queryAsync(
        `INSERT INTO reading_sessions (
          id, device_id, library_id, item_key, attachment_key, title_snapshot,
          started_at, ended_at, timezone, foreground_seconds, effective_seconds,
          model_version, updated_at, updated_by
        ) VALUES (?, ?, 1, 'PAPER', 'PDF', 'Same paper', 1000, 2000, 'UTC', ?, ?, 2, 2000, ?)`,
        [id, deviceID, seconds, seconds, deviceID],
      );
    }

    const firstNotes = new Map<string, SyncSnapshot>();
    const secondNotes = new Map<string, SyncSnapshot>();
    const firstSync = new PaperPetSyncCoordinator(
      first,
      makeCarrier(firstNotes),
    );
    const secondSync = new PaperPetSyncCoordinator(
      second,
      makeCarrier(secondNotes),
    );
    await firstSync.initialize(true);
    await secondSync.initialize(true);
    expect(firstNotes.size).toBe(1);
    expect(secondNotes.size).toBe(1);

    exchange(firstNotes, secondNotes);
    await firstSync.syncNow();
    await secondSync.syncNow();
    exchange(firstNotes, secondNotes);
    await firstSync.syncNow();
    await secondSync.syncNow();

    for (const database of [first, second]) {
      expect(
        await database.db.valueQueryAsync(
          "SELECT COUNT(*) FROM reading_sessions",
        ),
      ).toBe(2);
      expect(
        await database.db.valueQueryAsync(
          "SELECT SUM(effective_seconds) FROM item_totals",
        ),
      ).toBe(70);
    }
    const report = new DashboardRepository(first);
    const dateRange = { startDate: "1970-01-01", endDate: "1970-01-01" };
    const all = await report.getOverview(dateRange, 2_000);
    const local = await report.getOverview(dateRange, 2_000, "local");
    const remote = await report.getOverview(dateRange, 2_000, "remote");
    const specific = await report.getOverview(
      dateRange,
      2_000,
      "device:device-b",
    );
    expect(all.sessionCount).toBe(2);
    expect(all.sources).toHaveLength(2);
    expect(local).toMatchObject({ sessionCount: 1, effectiveSeconds: 30 });
    expect(remote).toMatchObject({ sessionCount: 1, effectiveSeconds: 40 });
    expect(specific).toMatchObject({ sessionCount: 1, effectiveSeconds: 40 });
    const detail = await report.getItemDetail(all.recentItems[0]);
    expect(detail.sessions.map((row) => row.deviceID).sort()).toEqual([
      "device-a",
      "device-b",
    ]);
    expect(firstSync.getStatus().peerSessionCount).toBe(1);
    expect(secondSync.getStatus().peerSessionCount).toBe(1);
    expect(firstSync.getStatus().peerConfirmedLocalCount).toBe(1);
    expect(secondSync.getStatus().peerConfirmedLocalCount).toBe(1);
    expect(await secondSettings.load()).toMatchObject({
      petSize: 140,
      syncEnabled: true,
    });

    await first.excludeSession("session-a", true);
    firstSync.markDirty();
    await firstSync.syncNow();
    exchange(firstNotes, secondNotes);
    await secondSync.syncNow();
    expect(
      await second.db.valueQueryAsync(
        "SELECT SUM(effective_seconds) FROM item_totals",
      ),
    ).toBe(40);
    expect(
      await second.db.valueQueryAsync("SELECT COUNT(*) FROM reading_sessions"),
    ).toBe(2);
    exchange(firstNotes, secondNotes);
    await firstSync.syncNow();
    expect(firstSync.getStatus().peerConfirmedLocalCount).toBe(1);

    await firstSync.shutdown();
    await secondSync.shutdown();
  });
});
