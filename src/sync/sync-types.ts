export const PAPERPET_SYNC_FORMAT = "paperpet-sync" as const;
export const PAPERPET_SYNC_SCHEMA_VERSION = 1;
export const PAPERPET_SYNC_NOTE_MARKER = "<!-- paperpet-sync-v1 -->";
export const PAPERPET_DEVICE_NOTE_PREFIX = "paperpet-sync-v2:";

export type SyncStatusCode =
  "disabled" | "idle" | "pending" | "syncing" | "waiting" | "error";

export interface SyncSessionRecord {
  id: string;
  deviceID: string;
  libraryRef: string;
  itemKey: string;
  sourceKey: string;
  titleSnapshot: string;
  startedAt: number;
  endedAt?: number;
  timezone: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
  noteEditingSeconds: number;
  annotationCount: number;
  excluded: boolean;
  deleted: boolean;
  modelVersion: number;
  updatedAt: number;
  updatedBy: string;
}

export interface SyncSemanticEventRecord {
  id: string;
  sessionID: string;
  type: string;
  startedAt: number;
  endedAt: number;
  count: number;
  pageIndex?: number;
}

export interface SyncSettingRecord {
  key: string;
  valueJSON: string;
  updatedAt: number;
  updatedBy: string;
}

export interface SyncSnapshot {
  format: typeof PAPERPET_SYNC_FORMAT;
  schemaVersion: number;
  exportedAt: number;
  exportedBy: string;
  contentHash: string;
  sessions: SyncSessionRecord[];
  events: SyncSemanticEventRecord[];
  settings: SyncSettingRecord[];
}

export interface SyncStatus {
  code: SyncStatusCode;
  message: string;
  lastLocalWriteAt?: number;
  lastPeerSeenAt?: number;
  lastLocalChangeAt?: number;
  localSessionCount?: number;
  peerSessionCount?: number;
  peerConfirmedLocalCount?: number;
  peerCount?: number;
}

export interface SyncCarrier {
  readAll(): Promise<SyncSnapshot[]>;
  readOwn(deviceID: string): Promise<SyncSnapshot | undefined>;
  write(deviceID: string, snapshot: SyncSnapshot): Promise<void>;
}

export function createEmptySyncSnapshot(
  exportedBy: string,
  exportedAt = Date.now(),
): SyncSnapshot {
  const snapshot: Omit<SyncSnapshot, "contentHash"> = {
    format: PAPERPET_SYNC_FORMAT,
    schemaVersion: PAPERPET_SYNC_SCHEMA_VERSION,
    exportedAt,
    exportedBy,
    sessions: [],
    events: [],
    settings: [],
  };
  return {
    ...snapshot,
    contentHash: hashSyncPayload(snapshot),
  };
}

export function hashSyncPayload(
  snapshot: Omit<SyncSnapshot, "contentHash">,
): string {
  const text = JSON.stringify(snapshot);
  // A deterministic local hash is sufficient for loop detection. It is not a
  // cryptographic signature and does not provide authentication.
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function validateSyncSnapshot(value: unknown): SyncSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("PaperPet sync data is not an object");
  }
  const candidate = value as Partial<SyncSnapshot>;
  if (candidate.format !== PAPERPET_SYNC_FORMAT) {
    throw new Error("PaperPet sync data has an unknown format");
  }
  if (candidate.schemaVersion !== PAPERPET_SYNC_SCHEMA_VERSION) {
    throw new Error(
      `PaperPet sync schema ${String(candidate.schemaVersion)} is not supported`,
    );
  }
  if (
    typeof candidate.exportedAt !== "number" ||
    typeof candidate.exportedBy !== "string" ||
    typeof candidate.contentHash !== "string" ||
    !Array.isArray(candidate.sessions) ||
    !Array.isArray(candidate.events) ||
    !Array.isArray(candidate.settings)
  ) {
    throw new Error("PaperPet sync data is incomplete");
  }
  if (
    !Number.isFinite(candidate.exportedAt) ||
    candidate.exportedBy.length === 0 ||
    !candidate.sessions.every(isSyncSession) ||
    !candidate.events.every(isSyncEvent) ||
    !candidate.settings.every(isSyncSetting)
  ) {
    throw new Error("PaperPet sync data contains invalid records");
  }
  const withoutHash = {
    format: candidate.format,
    schemaVersion: candidate.schemaVersion,
    exportedAt: candidate.exportedAt,
    exportedBy: candidate.exportedBy,
    sessions: candidate.sessions,
    events: candidate.events,
    settings: candidate.settings,
  } as Omit<SyncSnapshot, "contentHash">;
  if (hashSyncPayload(withoutHash) !== candidate.contentHash) {
    throw new Error("PaperPet sync data failed its integrity check");
  }
  return candidate as SyncSnapshot;
}

function isSyncSession(value: unknown): value is SyncSessionRecord {
  if (!isRecord(value)) return false;
  return (
    nonempty(value.id) &&
    nonempty(value.deviceID) &&
    nonempty(value.libraryRef) &&
    nonempty(value.itemKey) &&
    nonempty(value.sourceKey) &&
    typeof value.titleSnapshot === "string" &&
    nonempty(value.timezone) &&
    nonnegative(value.startedAt) &&
    (value.endedAt === undefined || nonnegative(value.endedAt)) &&
    nonnegative(value.foregroundSeconds) &&
    nonnegative(value.effectiveSeconds) &&
    nonnegative(value.noteEditingSeconds) &&
    nonnegative(value.annotationCount) &&
    typeof value.excluded === "boolean" &&
    typeof value.deleted === "boolean" &&
    nonnegative(value.modelVersion) &&
    nonnegative(value.updatedAt) &&
    nonempty(value.updatedBy)
  );
}

function isSyncEvent(value: unknown): value is SyncSemanticEventRecord {
  if (!isRecord(value)) return false;
  return (
    nonempty(value.id) &&
    nonempty(value.sessionID) &&
    nonempty(value.type) &&
    nonnegative(value.startedAt) &&
    nonnegative(value.endedAt) &&
    nonnegative(value.count) &&
    (value.pageIndex === undefined || nonnegative(value.pageIndex))
  );
}

function isSyncSetting(value: unknown): value is SyncSettingRecord {
  if (!isRecord(value)) return false;
  return (
    nonempty(value.key) &&
    typeof value.valueJSON === "string" &&
    nonnegative(value.updatedAt) &&
    typeof value.updatedBy === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function compareSyncVersion(
  left: { updatedAt: number; updatedBy: string },
  right: { updatedAt: number; updatedBy: string },
): number {
  return (
    left.updatedAt - right.updatedAt ||
    left.updatedBy.localeCompare(right.updatedBy)
  );
}

export function mergeSyncSnapshots(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  exportedAt = Date.now(),
  exportedBy = local.exportedBy,
): SyncSnapshot {
  const sessions = new Map(
    local.sessions.map((session) => [session.id, session]),
  );
  for (const session of remote.sessions) {
    const existing = sessions.get(session.id);
    if (!existing || compareSyncVersion(existing, session) < 0) {
      sessions.set(session.id, session);
    }
  }
  const events = new Map(local.events.map((event) => [event.id, event]));
  for (const event of remote.events) events.set(event.id, event);

  const settings = new Map(
    local.settings.map((setting) => [setting.key, setting]),
  );
  for (const setting of remote.settings) {
    const existing = settings.get(setting.key);
    if (!existing || compareSyncVersion(existing, setting) < 0) {
      settings.set(setting.key, setting);
    }
  }

  const payload: Omit<SyncSnapshot, "contentHash"> = {
    format: PAPERPET_SYNC_FORMAT,
    schemaVersion: PAPERPET_SYNC_SCHEMA_VERSION,
    exportedAt,
    exportedBy,
    sessions: [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    events: [...events.values()].sort((a, b) => a.id.localeCompare(b.id)),
    settings: [...settings.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  return { ...payload, contentHash: hashSyncPayload(payload) };
}
