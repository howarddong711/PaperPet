import {
  PAPERPET_DEVICE_NOTE_PREFIX,
  PAPERPET_SYNC_NOTE_MARKER,
  type SyncCarrier,
  type SyncSnapshot,
  validateSyncSnapshot,
} from "./sync-types";

// Zotero rejects long note bodies during data sync. Leave ample room for HTML
// and future server-side limits instead of filling a note to the boundary.
const CHUNK_LENGTH = 12_000;
const MAX_NOTE_LENGTH = 16_000;
const INLINE_PREFIX = "paperpet-sync-v3-inline:";
const MANIFEST_PREFIX = "paperpet-sync-v3-manifest:";
const CHUNK_PREFIX = "paperpet-sync-v3-chunk:";
const SPARE_PREFIX = "paperpet-sync-v3-spare:";

interface CarrierItem {
  libraryID: number;
  isNote: () => boolean;
  getNote: () => string;
  setNote: (content: string) => boolean;
  save: (options?: { skipSelect?: boolean }) => Promise<boolean | number>;
}

interface ChunkNote {
  deviceID: string;
  index: number;
  payload: string;
}

interface ManifestNote {
  deviceID: string;
  count: number;
  length: number;
  payloadHash: string;
}

/** Stores short, independently syncable Zotero notes for each device. */
export class ZoteroNoteCarrier implements SyncCarrier {
  private localCarrier?: CarrierItem;

  public readAll(): Promise<SyncSnapshot[]> {
    return this.collectSnapshots(true);
  }

  public async write(deviceID: string, snapshot: SyncSnapshot): Promise<void> {
    if (snapshot.exportedBy !== deviceID) {
      throw new Error("PaperPet sync snapshot belongs to another device");
    }
    const notes = await this.findNotes();
    const carrier = this.findLocalCarrier(deviceID, notes);
    const payload = encodeURIComponent(JSON.stringify(snapshot));
    const existingChunks = new Map<number, CarrierItem>();
    for (const item of notes) {
      const slot =
        parseChunkNote(item.getNote()) ?? parseSpareNote(item.getNote());
      if (slot?.deviceID === deviceID && !existingChunks.has(slot.index)) {
        existingChunks.set(slot.index, item);
      }
    }
    if (payload.length <= CHUNK_LENGTH) {
      await this.saveNote(carrier, `${INLINE_PREFIX}${deviceID}:${payload}`);
      for (const [index, item] of existingChunks) {
        await this.saveNote(item, `${SPARE_PREFIX}${deviceID}:${index}`);
      }
      return;
    }

    const chunks = splitPayload(payload);
    for (let index = 0; index < chunks.length; index += 1) {
      const item = existingChunks.get(index) ?? this.createNote();
      await this.saveNote(
        item,
        `${CHUNK_PREFIX}${deviceID}:${index}:${chunks[index]}`,
      );
    }
    // Commit the small manifest last. Readers ignore a generation until every
    // chunk has arrived locally; no partially transferred snapshot is imported.
    await this.saveNote(
      carrier,
      `${MANIFEST_PREFIX}${deviceID}:${chunks.length}:${payload.length}:${hashEncodedPayload(payload)}`,
    );
    for (const [index, item] of existingChunks) {
      if (index >= chunks.length) {
        await this.saveNote(item, `${SPARE_PREFIX}${deviceID}:${index}`);
      }
    }
    this.localCarrier = carrier;
  }

  public async readOwn(deviceID: string): Promise<SyncSnapshot | undefined> {
    const snapshots = (await this.collectSnapshots(false, false)).filter(
      (snapshot) => snapshot.exportedBy === deviceID,
    );
    return snapshots.sort((a, b) => b.exportedAt - a.exportedAt)[0];
  }

  private async collectSnapshots(
    includeLegacy: boolean,
    includeV2 = true,
  ): Promise<SyncSnapshot[]> {
    const snapshots: SyncSnapshot[] = [];
    const manifests: ManifestNote[] = [];
    const chunks = new Map<string, Map<number, string>>();
    for (const item of await this.findNotes()) {
      const note = item.getNote();
      const chunk = parseChunkNote(note);
      if (chunk) {
        const group = chunks.get(chunk.deviceID) ?? new Map<number, string>();
        group.set(chunk.index, chunk.payload);
        chunks.set(chunk.deviceID, group);
        continue;
      }
      if (parseSpareNote(note)) continue;
      const manifest = parseManifestNote(note);
      if (manifest) {
        manifests.push(manifest);
        continue;
      }
      const inline = parsePayloadNote(note, INLINE_PREFIX);
      if (inline) {
        snapshots.push(decodeSnapshot(inline.deviceID, inline.payload));
        continue;
      }
      const deviceNote = parsePayloadNote(note, PAPERPET_DEVICE_NOTE_PREFIX);
      if (deviceNote) {
        // V2 notes can be too long for Zotero's server. Treat them as missing
        // for local writes so the coordinator migrates them even when unchanged.
        if (includeV2) {
          snapshots.push(
            decodeSnapshot(deviceNote.deviceID, deviceNote.payload),
          );
        }
        continue;
      }
      if (
        note.includes(INLINE_PREFIX) ||
        note.includes(MANIFEST_PREFIX) ||
        note.includes(CHUNK_PREFIX) ||
        note.includes(PAPERPET_DEVICE_NOTE_PREFIX)
      ) {
        throw new Error("PaperPet sync note is incomplete or damaged");
      }
      if (!includeLegacy) continue;
      const markerIndex = note.indexOf(PAPERPET_SYNC_NOTE_MARKER);
      if (markerIndex < 0) continue;
      const payload = note
        .slice(markerIndex + PAPERPET_SYNC_NOTE_MARKER.length)
        .trim();
      if (payload) snapshots.push(validateSyncSnapshot(JSON.parse(payload)));
    }
    for (const manifest of manifests) {
      const group = chunks.get(manifest.deviceID);
      if (!group || group.size < manifest.count) continue;
      const parts: string[] = [];
      for (let index = 0; index < manifest.count; index += 1) {
        const part = group.get(index);
        if (part === undefined) break;
        parts.push(part);
      }
      // Zotero can deliver the manifest before its chunks. The next item
      // notification or periodic read will retry without touching local data.
      if (parts.length !== manifest.count) continue;
      const payload = parts.join("");
      // Zotero may deliver individual changed chunks before or after the
      // manifest. A mismatched set is temporary; retry after the next update.
      if (
        payload.length !== manifest.length ||
        hashEncodedPayload(payload) !== manifest.payloadHash
      )
        continue;
      snapshots.push(decodeSnapshot(manifest.deviceID, payload));
    }
    return snapshots;
  }

  private async findNotes(): Promise<CarrierItem[]> {
    const libraryID = Zotero.Libraries.userLibraryID;
    const candidates = await Zotero.Items.getAll(libraryID, true, false);
    return candidates.filter((candidate) =>
      candidate.isNote(),
    ) as CarrierItem[];
  }

  private findLocalCarrier(
    deviceID: string,
    notes: CarrierItem[],
  ): CarrierItem {
    if (this.localCarrier) return this.localCarrier;
    for (const candidate of notes) {
      const note = candidate.getNote();
      const owner =
        parseManifestNote(note)?.deviceID ??
        parsePayloadNote(note, INLINE_PREFIX)?.deviceID ??
        parsePayloadNote(note, PAPERPET_DEVICE_NOTE_PREFIX)?.deviceID;
      if (owner === deviceID) {
        this.localCarrier = candidate;
        return candidate;
      }
    }
    this.localCarrier = this.createNote();
    return this.localCarrier;
  }

  private createNote(): CarrierItem {
    const libraryID = Zotero.Libraries.userLibraryID;
    const ItemConstructor = (
      Zotero as unknown as { Item: new (type: string) => unknown }
    ).Item;
    const item = new ItemConstructor("note") as CarrierItem;
    item.libraryID = libraryID;
    return item;
  }

  private async saveNote(item: CarrierItem, marker: string): Promise<void> {
    const content = `<div data-schema-version="9"><p>PaperPet 同步数据（请勿编辑）</p><p>${marker}</p></div>`;
    if (content.length > MAX_NOTE_LENGTH) {
      throw new Error(
        "PaperPet sync chunk exceeds the safe Zotero note length",
      );
    }
    if (item.getNote() === content) return;
    item.setNote(content);
    const saved = await item.save({ skipSelect: true });
    if (!saved) throw new Error("Zotero did not save the PaperPet sync note");
  }
}

function splitPayload(payload: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_LENGTH) {
    chunks.push(payload.slice(offset, offset + CHUNK_LENGTH));
  }
  return chunks;
}

function hashEncodedPayload(payload: string): string {
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function decodeSnapshot(deviceID: string, payload: string): SyncSnapshot {
  const snapshot = validateSyncSnapshot(
    JSON.parse(decodeURIComponent(payload)) as unknown,
  );
  if (snapshot.exportedBy !== deviceID) {
    throw new Error("PaperPet sync note has a mismatched device ID");
  }
  return snapshot;
}

function parsePayloadNote(
  note: string,
  prefix: string,
): { deviceID: string; payload: string } | undefined {
  const match = note.match(
    new RegExp(`${prefix}([a-zA-Z0-9-]+):([A-Za-z0-9_.!~*'()%-]+)`),
  );
  return match ? { deviceID: match[1], payload: match[2] } : undefined;
}

function parseManifestNote(note: string): ManifestNote | undefined {
  const match = note.match(
    /paperpet-sync-v3-manifest:([a-zA-Z0-9-]+):(\d+):(\d+):([a-f0-9]{8})/,
  );
  return match
    ? {
        deviceID: match[1],
        count: Number(match[2]),
        length: Number(match[3]),
        payloadHash: match[4],
      }
    : undefined;
}

function parseChunkNote(note: string): ChunkNote | undefined {
  const match = note.match(
    /paperpet-sync-v3-chunk:([a-zA-Z0-9-]+):(\d+):([A-Za-z0-9_.!~*'()%-]+)/,
  );
  return match
    ? {
        deviceID: match[1],
        index: Number(match[2]),
        payload: match[3],
      }
    : undefined;
}

function parseSpareNote(
  note: string,
): { deviceID: string; index: number } | undefined {
  const match = note.match(/paperpet-sync-v3-spare:([a-zA-Z0-9-]+):(\d+)/);
  return match ? { deviceID: match[1], index: Number(match[2]) } : undefined;
}
