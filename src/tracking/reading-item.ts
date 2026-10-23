export interface ReaderItemIdentity {
  libraryID: number;
  itemKey: string;
  /** The source resource key: an attachment or a note, retained for DB compatibility. */
  attachmentKey: string;
  title: string;
}

export function getReadingItemIdentity(
  source?: Zotero.Item,
): ReaderItemIdentity | undefined {
  // A newly created note has no stable key until Zotero saves it for the first time.
  if (!source?.key) return undefined;
  let item = source;
  for (let depth = 0; item.parentItemID && depth < 3; depth += 1) {
    const parent = Zotero.Items.get(item.parentItemID);
    if (!parent || parent === item) break;
    item = parent;
  }
  return {
    libraryID: item.libraryID,
    itemKey: item.key,
    attachmentKey: source.key,
    title: getReadingItemTitle(item),
  };
}

export function getReadingItemTitle(item: Zotero.Item): string {
  return String(
    (item.isNote() ? item.getNoteTitle() : item.getField("title")) || "",
  ).trim();
}

export async function openReadingItem(
  item: Pick<ReaderItemIdentity, "libraryID" | "attachmentKey">,
): Promise<void> {
  const source = await Zotero.Items.getByLibraryAndKeyAsync(
    item.libraryID,
    item.attachmentKey,
  );
  if (!source)
    throw new Error("The Zotero attachment or note could not be found");
  if (source.isNote()) {
    await Zotero.Notes.open(source.id, undefined);
  } else {
    await Zotero.FileHandlers.open(source);
  }
}
