import type { ReadingMode } from "../model/reading-activity-model";

export const CHARACTER_PACK_SCHEMA_VERSION = 1;
export const REQUIRED_ACTIONS = [
  "idle",
  "reading",
  "thinking",
  "sleeping",
] as const;

export const CHARACTER_PACK_LIMITS = {
  compressedBytes: 50 * 1024 * 1024,
  uncompressedBytes: 200 * 1024 * 1024,
  fileCount: 1_000,
  imageDimension: 4_096,
  framesPerSecond: 30,
} as const;

export type CharacterRenderer =
  "static-image" | "animated-image" | "frame-sequence" | "spritesheet";

export interface CharacterAction {
  asset: string;
  weight?: number;
  durationMs?: number;
  loop?: boolean;
  framesPerSecond?: number;
  audio?: string;
}

export interface CharacterPackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  renderer: CharacterRenderer;
  actions: Record<string, CharacterAction | CharacterAction[]>;
}

export interface CharacterPackArchiveStats {
  compressedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  maximumImageWidth?: number;
  maximumImageHeight?: number;
}

export interface CharacterPackValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: CharacterPackManifest;
}

export interface ResolvedCharacterAction {
  requestedAction: string;
  resolvedAction: string;
  variants: CharacterAction[];
}

const RENDERERS = new Set<CharacterRenderer>([
  "static-image",
  "animated-image",
  "frame-sequence",
  "spritesheet",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".apng", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav"]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".cjs",
  ".dll",
  ".dylib",
  ".exe",
  ".html",
  ".jar",
  ".js",
  ".mjs",
  ".sh",
  ".wasm",
  ".xhtml",
]);

const ACTION_FALLBACKS: Record<string, string[]> = {
  annotating: ["annotating", "reading", "idle"],
  away: ["away", "idle"],
  clicked: ["clicked", "idle"],
  dragged: ["dragged", "idle"],
  idle: ["idle"],
  reading: ["reading", "idle"],
  searching: ["searching", "thinking", "idle"],
  skimming: ["skimming", "reading", "idle"],
  sleeping: ["sleeping", "idle"],
  thinking: ["thinking", "idle"],
  uncertain: ["uncertain", "idle"],
};

export function readingModeToCharacterAction(mode: ReadingMode): string {
  return mode;
}

export function resolveCharacterAction(
  manifest: CharacterPackManifest,
  requestedAction: string,
): ResolvedCharacterAction {
  const candidates = ACTION_FALLBACKS[requestedAction] ?? [
    requestedAction,
    "idle",
  ];
  const resolvedAction =
    candidates.find((candidate) => manifest.actions[candidate]) ?? "idle";
  const configured = manifest.actions[resolvedAction];
  return {
    requestedAction,
    resolvedAction,
    variants: Array.isArray(configured) ? configured : [configured],
  };
}

export function validateCharacterPack(
  candidate: unknown,
  archiveEntries: readonly string[],
  archiveStats?: CharacterPackArchiveStats,
): CharacterPackValidationResult {
  const errors: string[] = [];
  if (!isRecord(candidate)) {
    return { valid: false, errors: ["manifest must be a JSON object"] };
  }

  validateArchiveEntries(archiveEntries, errors);
  if (archiveStats) {
    validateArchiveStats(archiveStats, errors);
  }

  if (candidate.schemaVersion !== CHARACTER_PACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CHARACTER_PACK_SCHEMA_VERSION}`);
  }
  for (const field of ["id", "name", "version", "author", "license"]) {
    if (!isNonEmptyString(candidate[field])) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (
    typeof candidate.id === "string" &&
    !/^[a-z0-9][a-z0-9._-]{2,159}$/i.test(candidate.id)
  ) {
    errors.push("id contains unsupported characters");
  }
  if (
    typeof candidate.version === "string" &&
    !/^[0-9a-z][0-9a-z._+-]{0,39}$/i.test(candidate.version)
  ) {
    errors.push("version contains unsupported characters");
  }
  if (
    typeof candidate.renderer !== "string" ||
    !RENDERERS.has(candidate.renderer as CharacterRenderer)
  ) {
    errors.push("renderer is not supported");
  }
  if (!isRecord(candidate.actions)) {
    errors.push("actions must be an object");
    return { valid: false, errors };
  }

  for (const required of REQUIRED_ACTIONS) {
    if (!(required in candidate.actions)) {
      errors.push(`required action is missing: ${required}`);
    }
  }

  const entrySet = new Set(archiveEntries);
  for (const [name, configured] of Object.entries(candidate.actions)) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) {
      errors.push(`invalid action name: ${name}`);
      continue;
    }
    const variants = Array.isArray(configured) ? configured : [configured];
    if (variants.length === 0 || variants.length > 16) {
      errors.push(`action ${name} must contain between 1 and 16 variants`);
      continue;
    }
    for (const [index, variant] of variants.entries()) {
      validateAction(name, index, variant, entrySet, errors);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    errors,
    manifest: candidate as unknown as CharacterPackManifest,
  };
}

function validateArchiveEntries(
  entries: readonly string[],
  errors: string[],
): void {
  const normalized = new Set<string>();
  for (const entry of entries) {
    if (!isSafeCharacterPackPath(entry)) {
      errors.push(`unsafe archive path: ${entry}`);
    }
    const lower = entry.toLowerCase();
    if (normalized.has(lower)) {
      errors.push(`duplicate archive path: ${entry}`);
    }
    normalized.add(lower);
    if (EXECUTABLE_EXTENSIONS.has(extensionOf(lower))) {
      errors.push(`executable content is not allowed: ${entry}`);
    }
  }
}

function validateArchiveStats(
  stats: CharacterPackArchiveStats,
  errors: string[],
): void {
  if (stats.compressedBytes > CHARACTER_PACK_LIMITS.compressedBytes) {
    errors.push("compressed package exceeds 50 MB");
  }
  if (stats.uncompressedBytes > CHARACTER_PACK_LIMITS.uncompressedBytes) {
    errors.push("uncompressed package exceeds 200 MB");
  }
  if (stats.fileCount > CHARACTER_PACK_LIMITS.fileCount) {
    errors.push("package contains more than 1000 files");
  }
  if (
    (stats.maximumImageWidth ?? 0) > CHARACTER_PACK_LIMITS.imageDimension ||
    (stats.maximumImageHeight ?? 0) > CHARACTER_PACK_LIMITS.imageDimension
  ) {
    errors.push("image dimensions exceed 4096 px");
  }
}

function validateAction(
  name: string,
  index: number,
  candidate: unknown,
  entries: ReadonlySet<string>,
  errors: string[],
): void {
  const label = `${name}[${index}]`;
  if (!isRecord(candidate)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (
    !isNonEmptyString(candidate.asset) ||
    !isSafeCharacterPackPath(candidate.asset)
  ) {
    errors.push(`${label}.asset must be a safe relative path`);
  } else if (!assetExists(candidate.asset, entries)) {
    errors.push(`${label}.asset does not exist: ${candidate.asset}`);
  } else if (!isSupportedImageAsset(candidate.asset, entries)) {
    errors.push(`${label}.asset must contain PNG, APNG, or WebP resources`);
  }

  if (
    candidate.framesPerSecond !== undefined &&
    (!isFiniteNumber(candidate.framesPerSecond) ||
      candidate.framesPerSecond <= 0 ||
      candidate.framesPerSecond > CHARACTER_PACK_LIMITS.framesPerSecond)
  ) {
    errors.push(`${label}.framesPerSecond must be between 1 and 30`);
  }
  if (
    candidate.durationMs !== undefined &&
    (!isFiniteNumber(candidate.durationMs) ||
      candidate.durationMs < 100 ||
      candidate.durationMs > 60_000)
  ) {
    errors.push(`${label}.durationMs must be between 100 and 60000`);
  }
  if (
    candidate.weight !== undefined &&
    (!isFiniteNumber(candidate.weight) ||
      candidate.weight <= 0 ||
      candidate.weight > 100)
  ) {
    errors.push(`${label}.weight must be between 0 and 100`);
  }
  if (candidate.loop !== undefined && typeof candidate.loop !== "boolean") {
    errors.push(`${label}.loop must be a boolean`);
  }
  if (candidate.audio !== undefined) {
    if (
      !isNonEmptyString(candidate.audio) ||
      !isSafeCharacterPackPath(candidate.audio) ||
      !entries.has(candidate.audio) ||
      !AUDIO_EXTENSIONS.has(extensionOf(candidate.audio))
    ) {
      errors.push(`${label}.audio must reference an MP3, OGG, or WAV file`);
    }
  }
}

function assetExists(asset: string, entries: ReadonlySet<string>): boolean {
  return (
    entries.has(asset) ||
    [...entries].some((entry) => entry.startsWith(`${asset}/`))
  );
}

function isSupportedImageAsset(
  asset: string,
  entries: ReadonlySet<string>,
): boolean {
  if (IMAGE_EXTENSIONS.has(extensionOf(asset))) {
    return true;
  }
  return [...entries].some(
    (entry) =>
      entry.startsWith(`${asset}/`) && IMAGE_EXTENSIONS.has(extensionOf(entry)),
  );
}

export function isSafeCharacterPackPath(path: string): boolean {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    return false;
  }
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!normalized) {
    return false;
  }
  const parts = normalized.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function extensionOf(path: string): string {
  const match = /(?:^|\/)[^/]*(\.[a-z0-9]+)$/i.exec(path);
  return match?.[1].toLowerCase() ?? "";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
