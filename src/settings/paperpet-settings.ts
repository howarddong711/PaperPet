import type { PaperPetDatabase } from "../storage/paperpet-database";

export interface PaperPetSettings {
  petSize: number;
  petOpacity: number;
  reduceMotion: boolean;
  dragThreshold: number;
  doubleClickDelay: number;
  trackingEnabled: boolean;
  personalWordsPerMinute: number;
  defaultExpectedSeconds: number;
  sleepDelaySeconds: number;
  semanticEventRetentionDays: number;
}

export const DEFAULT_PAPERPET_SETTINGS: Readonly<PaperPetSettings> = {
  petSize: 98,
  petOpacity: 100,
  reduceMotion: false,
  dragThreshold: 6,
  doubleClickDelay: 260,
  trackingEnabled: true,
  personalWordsPerMinute: 200,
  defaultExpectedSeconds: 60,
  sleepDelaySeconds: 15,
  semanticEventRetentionDays: 90,
};

const SETTINGS_KEY = "user_preferences_v1";

export class PaperPetSettingsStore {
  public constructor(private readonly database: PaperPetDatabase) {}

  public async load(): Promise<PaperPetSettings> {
    const stored = await this.database.getSetting<unknown>(SETTINGS_KEY);
    return normalizePaperPetSettings(stored);
  }

  public async save(candidate: unknown): Promise<PaperPetSettings> {
    const settings = normalizePaperPetSettings(candidate);
    await this.database.setSetting(SETTINGS_KEY, settings);
    return settings;
  }
}

export function normalizePaperPetSettings(
  candidate: unknown,
): PaperPetSettings {
  const values = isRecord(candidate) ? candidate : {};
  return {
    petSize: boundedNumber(values.petSize, 48, 600, 1, 98),
    petOpacity: boundedNumber(values.petOpacity, 30, 100, 1, 100),
    reduceMotion: booleanValue(values.reduceMotion, false),
    dragThreshold: boundedNumber(values.dragThreshold, 2, 48, 1, 6),
    doubleClickDelay: boundedNumber(
      values.doubleClickDelay,
      180,
      1_000,
      10,
      260,
    ),
    trackingEnabled: booleanValue(values.trackingEnabled, true),
    personalWordsPerMinute: boundedNumber(
      values.personalWordsPerMinute,
      80,
      1_200,
      5,
      200,
    ),
    defaultExpectedSeconds: boundedNumber(
      values.defaultExpectedSeconds,
      15,
      600,
      5,
      60,
    ),
    sleepDelaySeconds: boundedNumber(values.sleepDelaySeconds, 5, 600, 5, 15),
    semanticEventRetentionDays: boundedNumber(
      values.semanticEventRetentionDays,
      7,
      730,
      1,
      90,
    ),
  };
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  step: number,
  fallback: number,
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const clamped = Math.min(maximum, Math.max(minimum, numeric));
  return Math.round(clamped / step) * step;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
