import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getReadingItemIdentity,
  openReadingItem,
} from "../src/tracking/reading-item";

afterEach(() => vi.unstubAllGlobals());

describe("note identity and continue reading", () => {
  it("attributes child notes to their paper and retains the note as the source", () => {
    const paper = {
      libraryID: 1,
      key: "PAPER",
      isNote: () => false,
      getField: () => "Paper title",
    };
    vi.stubGlobal("Zotero", { Items: { get: () => paper } });
    const note = { key: "NOTE", parentItemID: 1 } as Zotero.Item;
    expect(getReadingItemIdentity(note)).toEqual({
      libraryID: 1,
      itemKey: "PAPER",
      attachmentKey: "NOTE",
      title: "Paper title",
    });
  });

  it("does not create a database identity for an unsaved note", () => {
    expect(getReadingItemIdentity({ key: "" } as Zotero.Item)).toBeUndefined();
  });

  it("reopens a note via Zotero Notes, and leaves PDF opening unchanged", async () => {
    const source = { id: 3, isNote: () => true };
    const openNote = vi.fn().mockResolvedValue(undefined);
    const openFile = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Zotero", {
      Items: { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(source) },
      Notes: { open: openNote },
      FileHandlers: { open: openFile },
    });
    await openReadingItem({ libraryID: 1, attachmentKey: "NOTE" });
    expect(openNote).toHaveBeenCalledWith(3, undefined);
    expect(openFile).not.toHaveBeenCalled();
    source.isNote = () => false;
    await openReadingItem({ libraryID: 1, attachmentKey: "PDF" });
    expect(openFile).toHaveBeenCalledWith(source);
  });

  it("reports a missing source instead of opening an unrelated last PDF", async () => {
    vi.stubGlobal("Zotero", {
      Items: { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(false) },
    });
    await expect(
      openReadingItem({ libraryID: 1, attachmentKey: "MISSING" }),
    ).rejects.toThrow("could not be found");
  });
});
