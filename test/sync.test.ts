import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperPetSyncCoordinator } from "../src/sync/sync-coordinator";
import { ZoteroNoteCarrier } from "../src/sync/zotero-note-carrier";
import {
  createEmptySyncSnapshot,
  hashSyncPayload,
  mergeSyncSnapshots,
  validateSyncSnapshot,
  type SyncCarrier,
  type SyncSessionRecord,
} from "../src/sync/sync-types";
import type { PaperPetDatabase } from "../src/storage/paperpet-database";

afterEach(() => vi.unstubAllGlobals());

function session(
  id: string,
  updatedAt: number,
  updatedBy: string,
): SyncSessionRecord {
  return {
    id,
    deviceID: updatedBy,
    libraryRef: "user",
    itemKey: `ITEM-${id}`,
    sourceKey: `SOURCE-${id}`,
    titleSnapshot: `Title ${id}`,
    startedAt: 1,
    endedAt: 2,
    timezone: "Asia/Shanghai",
    foregroundSeconds: 1,
    effectiveSeconds: 1,
    noteEditingSeconds: 0,
    annotationCount: 0,
    excluded: false,
    deleted: false,
    modelVersion: 2,
    updatedAt,
    updatedBy,
  };
}

describe("PaperPet sync format", () => {
  it("rejects a snapshot whose content hash no longer matches", () => {
    const snapshot = createEmptySyncSnapshot("device-a", 1);
    const tampered = {
      ...snapshot,
      exportedBy: "device-b",
    };
    expect(() => validateSyncSnapshot(tampered)).toThrow("integrity check");
  });

  it("rejects invalid session fields even when the hash matches", () => {
    const snapshot = createEmptySyncSnapshot("device-a", 1);
    const invalid = {
      ...snapshot,
      sessions: [{ ...session("bad", 2, "device-a"), effectiveSeconds: -1 }],
    };
    invalid.contentHash = hashSyncPayload({
      format: invalid.format,
      schemaVersion: invalid.schemaVersion,
      exportedAt: invalid.exportedAt,
      exportedBy: invalid.exportedBy,
      sessions: invalid.sessions,
      events: invalid.events,
      settings: invalid.settings,
    });
    expect(() => validateSyncSnapshot(invalid)).toThrow("invalid records");
  });

  it("merges sessions with deterministic LWW and deduplicates events and settings", () => {
    const local = createEmptySyncSnapshot("device-a", 1);
    local.sessions = [session("same", 10, "device-a")];
    local.events = [
      {
        id: "event-1",
        sessionID: "same",
        type: "selection",
        startedAt: 1,
        endedAt: 2,
        count: 1,
      },
    ];
    local.settings = [
      {
        key: "paperpet.settings",
        valueJSON: "old",
        updatedAt: 10,
        updatedBy: "device-a",
      },
    ];
    local.contentHash = hashSyncPayload({
      format: local.format,
      schemaVersion: local.schemaVersion,
      exportedAt: local.exportedAt,
      exportedBy: local.exportedBy,
      sessions: local.sessions,
      events: local.events,
      settings: local.settings,
    });

    const remote = createEmptySyncSnapshot("device-b", 2);
    remote.sessions = [
      session("same", 10, "device-b"),
      session("remote-only", 20, "device-b"),
    ];
    remote.events = [
      ...local.events,
      {
        id: "event-2",
        sessionID: "remote-only",
        type: "search",
        startedAt: 3,
        endedAt: 4,
        count: 1,
      },
    ];
    remote.settings = [
      {
        key: "paperpet.settings",
        valueJSON: "new",
        updatedAt: 10,
        updatedBy: "device-b",
      },
    ];
    remote.contentHash = hashSyncPayload({
      format: remote.format,
      schemaVersion: remote.schemaVersion,
      exportedAt: remote.exportedAt,
      exportedBy: remote.exportedBy,
      sessions: remote.sessions,
      events: remote.events,
      settings: remote.settings,
    });

    const merged = mergeSyncSnapshots(local, remote, 3, "device-a");
    expect(merged.sessions.map((item) => item.id)).toEqual([
      "remote-only",
      "same",
    ]);
    expect(merged.sessions.find((item) => item.id === "same")?.updatedBy).toBe(
      "device-b",
    );
    expect(merged.events.map((item) => item.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(merged.settings[0]?.valueJSON).toBe("new");
    expect(validateSyncSnapshot(merged)).toEqual(merged);
  });
});

describe("ZoteroNoteCarrier", () => {
  it("writes one note per device and reads both notes", async () => {
    const notes: Array<{
      libraryID: number;
      isNote: () => boolean;
      getNote: () => string;
      setNote: (value: string) => boolean;
      save: () => Promise<boolean>;
    }> = [];
    const Item = vi.fn(function MockItem() {
      let content = "";
      const item = {
        libraryID: 1,
        isNote: () => true,
        getNote: () => content,
        setNote: (value: string) => {
          content = value;
          return true;
        },
        save: async () => {
          if (!notes.includes(item)) notes.push(item);
          return true;
        },
      };
      return item;
    });
    vi.stubGlobal("Zotero", {
      Libraries: { userLibraryID: 1 },
      Items: { getAll: vi.fn(async () => notes) },
      Item,
    });
    const a = new ZoteroNoteCarrier();
    const b = new ZoteroNoteCarrier();
    const first = createEmptySyncSnapshot("device-a", 1);
    const second = createEmptySyncSnapshot("device-b", 2);

    await a.write("device-a", first);
    await b.write("device-b", second);
    expect(notes).toHaveLength(2);
    expect(notes[0].getNote()).toContain("paperpet-sync-v3-inline:device-a:");
    await expect(a.readAll()).resolves.toEqual([first, second]);
    await expect(a.readOwn("device-a")).resolves.toEqual(first);
    await a.write("device-a", first);
    expect(notes).toHaveLength(2);
    await new ZoteroNoteCarrier().write("device-a", first);
    expect(notes).toHaveLength(2);
    expect(Item).toHaveBeenCalledTimes(2);
  });

  it("migrates an oversized V2 note into short chunks and waits for all chunks", async () => {
    const snapshot = createEmptySyncSnapshot("device-a", 3);
    snapshot.sessions = Array.from({ length: 180 }, (_, index) => ({
      ...session(String(index), index + 1, "device-a"),
      titleSnapshot: `Paper ${index} ${"长标题".repeat(30)}`,
    }));
    snapshot.contentHash = hashSyncPayload({
      format: snapshot.format,
      schemaVersion: snapshot.schemaVersion,
      exportedAt: snapshot.exportedAt,
      exportedBy: snapshot.exportedBy,
      sessions: snapshot.sessions,
      events: snapshot.events,
      settings: snapshot.settings,
    });
    const oldContent = `<div><p>paperpet-sync-v2:device-a:${encodeURIComponent(JSON.stringify(snapshot))}</p></div>`;
    expect(oldContent.length).toBeGreaterThan(16_000);

    const notes: Array<{
      libraryID: number;
      isNote: () => boolean;
      getNote: () => string;
      setNote: (value: string) => boolean;
      save: () => Promise<boolean>;
    }> = [];
    let saveCalls = 0;
    const Item = vi.fn(function MockItem() {
      let content = "";
      const item = {
        libraryID: 1,
        isNote: () => true,
        getNote: () => content,
        setNote: (value: string) => {
          content = value;
          return true;
        },
        save: async () => {
          saveCalls += 1;
          if (!notes.includes(item)) notes.push(item);
          return true;
        },
      };
      return item;
    });
    const old = new Item();
    old.setNote(oldContent);
    await old.save();
    vi.stubGlobal("Zotero", {
      Libraries: { userLibraryID: 1 },
      Items: { getAll: vi.fn(async () => notes) },
      Item,
    });
    const carrier = new ZoteroNoteCarrier();
    await expect(carrier.readAll()).resolves.toEqual([snapshot]);
    // The coordinator must rewrite V2 even if the data itself is unchanged.
    await expect(carrier.readOwn("device-a")).resolves.toBeUndefined();
    await carrier.write("device-a", snapshot);
    expect(notes[0].getNote()).toContain("paperpet-sync-v3-manifest:");
    expect(notes.length).toBeGreaterThan(2);
    expect(notes.every((note) => note.getNote().length <= 16_000)).toBe(true);
    await expect(carrier.readAll()).resolves.toEqual([snapshot]);
    await expect(carrier.readOwn("device-a")).resolves.toEqual(snapshot);

    const noteCount = notes.length;
    const previousContents = notes.map((note) => note.getNote());
    const updated = {
      ...snapshot,
      exportedAt: 5,
      sessions: snapshot.sessions.map((record, index) =>
        index === snapshot.sessions.length - 1
          ? { ...record, titleSnapshot: `${record.titleSnapshot} revised` }
          : record,
      ),
    };
    updated.contentHash = hashSyncPayload({
      format: updated.format,
      schemaVersion: updated.schemaVersion,
      exportedAt: updated.exportedAt,
      exportedBy: updated.exportedBy,
      sessions: updated.sessions,
      events: updated.events,
      settings: updated.settings,
    });
    await carrier.write("device-a", updated);
    expect(
      notes.filter((note, index) => note.getNote() !== previousContents[index])
        .length,
    ).toBeLessThan(noteCount);
    await expect(carrier.readAll()).resolves.toEqual([updated]);
    const currentManifest = notes[0].getNote();
    notes[0].setNote(previousContents[0]);
    await expect(carrier.readAll()).resolves.toEqual([]);
    notes[0].setNote(currentManifest);

    const writesBeforeRepeat = saveCalls;
    await carrier.write("device-a", updated);
    expect(notes).toHaveLength(noteCount);
    expect(saveCalls).toBe(writesBeforeRepeat);

    const missing = notes.find(
      (note) =>
        note.getNote().includes("paperpet-sync-v3-chunk:device-a:") &&
        note.getNote().includes(":1:"),
    );
    expect(missing).toBeDefined();
    const remoteNotes = notes.filter((note) => note !== missing);
    vi.stubGlobal("Zotero", {
      Libraries: { userLibraryID: 1 },
      Items: { getAll: vi.fn(async () => remoteNotes) },
    });
    await expect(new ZoteroNoteCarrier().readAll()).resolves.toEqual([]);
    remoteNotes.push(missing!);
    await expect(new ZoteroNoteCarrier().readAll()).resolves.toEqual([updated]);

    vi.stubGlobal("Zotero", {
      Libraries: { userLibraryID: 1 },
      Items: { getAll: vi.fn(async () => notes) },
      Item,
    });
    const small = createEmptySyncSnapshot("device-a", 4);
    await carrier.write("device-a", small);
    expect(notes).toHaveLength(noteCount);
    expect(
      notes.filter((note) =>
        note.getNote().includes("paperpet-sync-v3-spare:"),
      ),
    ).toHaveLength(noteCount - 1);
    await expect(carrier.readAll()).resolves.toEqual([small]);
    await carrier.write("device-a", updated);
    expect(notes).toHaveLength(noteCount);
    await expect(carrier.readAll()).resolves.toEqual([updated]);
  });

  it("still reads the legacy shared note", async () => {
    const snapshot = createEmptySyncSnapshot("old-device", 1);
    vi.stubGlobal("Zotero", {
      Libraries: { userLibraryID: 1 },
      Items: {
        getAll: vi.fn().mockResolvedValue([
          {
            isNote: () => true,
            getNote: () =>
              `<!-- paperpet-sync-v1 -->\n${JSON.stringify(snapshot)}`,
          },
        ]),
      },
    });
    const carrier = new ZoteroNoteCarrier();
    await expect(carrier.readAll()).resolves.toEqual([snapshot]);
    await expect(carrier.readOwn("old-device")).resolves.toBeUndefined();
  });
});

describe("PaperPetSyncCoordinator", () => {
  it("reports a damaged carrier without importing partial data", async () => {
    const mergeSyncSnapshot = vi.fn();
    vi.stubGlobal("Zotero", {
      Notifier: {
        registerObserver: () => "observer",
        unregisterObserver: vi.fn(),
      },
      getMainWindows: () => [],
      logError: vi.fn(),
    });
    const database = {
      getOrCreateDeviceID: vi.fn().mockResolvedValue("device-a"),
      mergeSyncSnapshot,
    } as unknown as PaperPetDatabase;
    const carrier: SyncCarrier = {
      readAll: vi
        .fn()
        .mockRejectedValue(
          new Error("PaperPet sync data failed its integrity check"),
        ),
      readOwn: vi.fn(),
      write: vi.fn(),
    };
    const coordinator = new PaperPetSyncCoordinator(database, carrier);

    await coordinator.initialize(true);
    expect(coordinator.getStatus().code).toBe("error");
    await expect(coordinator.syncNow()).rejects.toThrow("integrity check");
    expect(mergeSyncSnapshot).not.toHaveBeenCalled();
    expect(carrier.write).not.toHaveBeenCalled();
  });

  it("pulls when Zotero reports an item change and unregisters on shutdown", async () => {
    const notify = vi.fn();
    const unregisterObserver = vi.fn();
    const syncZotero = vi.fn();
    let notifyCallback: (() => void) | undefined;
    let pollCallback: (() => void) | undefined;
    vi.stubGlobal("Zotero", {
      Notifier: {
        registerObserver: vi.fn((observer: { notify: typeof notify }) => {
          notify.mockImplementation(observer.notify);
          return "observer";
        }),
        unregisterObserver,
      },
      getMainWindows: () => [
        {
          setTimeout: (callback: () => void) => {
            notifyCallback = callback;
            return 1;
          },
          clearTimeout: vi.fn(),
          setInterval: vi.fn((callback: () => void) => {
            pollCallback = callback;
            return 2;
          }),
          clearInterval: vi.fn(),
          ZoteroPane: { sync: syncZotero },
        },
      ],
      Items: { get: (id: number) => ({ isNote: () => id === 1 }) },
      logError: vi.fn(),
    });
    const database = {
      getOrCreateDeviceID: vi.fn().mockResolvedValue("device-a"),
      mergeSyncSnapshot: vi
        .fn()
        .mockResolvedValue({ sessions: 0, events: 0, settings: 0 }),
      exportSyncSnapshot: vi
        .fn()
        .mockResolvedValue(createEmptySyncSnapshot("device-a", 1)),
    } as unknown as PaperPetDatabase;
    const carrier: SyncCarrier = {
      readAll: vi.fn().mockResolvedValue([]),
      readOwn: vi.fn().mockResolvedValue(undefined),
      write: vi.fn(),
    };
    const coordinator = new PaperPetSyncCoordinator(database, carrier);

    await coordinator.initialize(true);
    expect(carrier.readAll).toHaveBeenCalledTimes(1);
    await coordinator.readNow();
    expect(carrier.readAll).toHaveBeenCalledTimes(2);
    expect(syncZotero).toHaveBeenCalledTimes(1);
    vi.mocked(carrier.readAll).mockResolvedValue([
      createEmptySyncSnapshot("device-b", 2),
    ]);
    pollCallback?.();
    await coordinator.pull();
    expect(carrier.readAll).toHaveBeenCalledTimes(4);
    expect(coordinator.getStatus().peerCount).toBe(1);
    notify("modify", "item", [2]);
    expect(carrier.readAll).toHaveBeenCalledTimes(4);
    notify("modify", "item", [1]);
    notifyCallback?.();
    await Promise.resolve();
    await coordinator.pull();
    expect(carrier.readAll).toHaveBeenCalledTimes(6);

    await coordinator.shutdown();
    expect(unregisterObserver).toHaveBeenCalledWith("observer");
  });

  it("keeps disabled sync local and reports the disabled state", async () => {
    const database = {
      getOrCreateDeviceID: vi.fn().mockResolvedValue("device-a"),
    } as unknown as PaperPetDatabase;
    const carrier: SyncCarrier = {
      readAll: vi.fn(),
      readOwn: vi.fn(),
      write: vi.fn(),
    };
    const coordinator = new PaperPetSyncCoordinator(database, carrier);

    await coordinator.initialize(false);
    coordinator.markDirty();

    expect(coordinator.getStatus()).toEqual({
      code: "disabled",
      message: "同步未启用",
    });
    expect(carrier.readAll).not.toHaveBeenCalled();
    expect(carrier.write).not.toHaveBeenCalled();
  });
});
