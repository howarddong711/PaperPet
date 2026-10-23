import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadingSessionCoordinator } from "../src/sessions/reading-session-coordinator";
import type { PaperPetDatabase } from "../src/storage/paperpet-database";
import type { ReadingActivitySnapshot } from "../src/model/reading-activity-model";

afterEach(() => vi.unstubAllGlobals());

describe("note session persistence", () => {
  it("stores note-edit events separately without inflating PDF annotation counts", async () => {
    let sequence = 0;
    vi.stubGlobal("Services", {
      uuid: { generateUUID: () => `uuid-${sequence++}` },
    });
    const logError = vi.fn();
    vi.stubGlobal("Zotero", { logError });
    const queryAsync = vi.fn().mockResolvedValue([]);
    const database = {
      getOrCreateDeviceID: async () => "device",
      db: {
        queryAsync,
        executeTransaction: async (operation: () => Promise<void>) =>
          operation(),
      },
    } as unknown as PaperPetDatabase;
    const sessions = new ReadingSessionCoordinator(database);
    await sessions.initialize();
    const snapshot: ReadingActivitySnapshot = {
      mode: "annotating",
      confidence: 1,
      foregroundReaderSeconds: 1,
      foregroundDeltaSeconds: 1,
      effectiveReadingSeconds: 1,
      effectiveDeltaSeconds: 1,
      noteEditingSeconds: 0.75,
      noteEditingDeltaSeconds: 0.75,
      expectedReadingSeconds: 60,
    };
    sessions.acceptUpdate({
      observedAt: 1_000,
      snapshot,
      item: {
        libraryID: 1,
        itemKey: "PAPER",
        attachmentKey: "NOTE",
        title: "Paper title",
      },
    });
    sessions.recordSemanticEvent({ type: "note-edit", observedAt: 1_000 });
    sessions.recordSemanticEvent({ type: "note-edit", observedAt: 1_500 });
    expect(sessions.getCurrentSession()?.annotationCount).toBe(0);
    expect(sessions.getCurrentSession()?.noteEditingSeconds).toBe(0.75);
    expect(sessions.getCurrentSession()?.item.attachmentKey).toBe("NOTE");
    // An inactive main-window controller must not replace this foreground note.
    sessions.acceptUpdate({
      observedAt: 2_000,
      snapshot: {
        ...snapshot,
        effectiveDeltaSeconds: 0,
        foregroundDeltaSeconds: 0,
        noteEditingDeltaSeconds: 0,
      },
    });
    expect(sessions.getCurrentSession()?.item.attachmentKey).toBe("NOTE");
    await sessions.shutdown(3_000);
    expect(logError).not.toHaveBeenCalled();
    const calls = queryAsync.mock.calls as [string, unknown[]][];
    const event = calls.find(([sql]) =>
      sql.includes("INSERT INTO semantic_events"),
    );
    expect(event?.[1][2]).toBe("note-edit");
    expect(event?.[1][5]).toBe(2);
    const persisted = calls.find(([sql]) =>
      sql.includes("UPDATE reading_sessions SET"),
    );
    expect(persisted?.[1].slice(1, 5)).toEqual([1, 1, 0.75, 0]);
  });
});
