import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PAPERPET_SETTINGS,
  normalizePaperPetSettings,
  PaperPetSettingsStore,
} from "../src/settings/paperpet-settings";
import type { PaperPetDatabase } from "../src/storage/paperpet-database";

describe("normalizePaperPetSettings", () => {
  it("uses safe defaults for absent or invalid values", () => {
    expect(normalizePaperPetSettings(undefined)).toEqual(
      DEFAULT_PAPERPET_SETTINGS,
    );
    expect(normalizePaperPetSettings({ petSize: "large" })).toEqual(
      DEFAULT_PAPERPET_SETTINGS,
    );
  });

  it("clamps and rounds user-controlled numeric settings", () => {
    expect(
      normalizePaperPetSettings({
        petSize: 1_000,
        petOpacity: 12,
        dragThreshold: 7.4,
        doubleClickDelay: 333,
        personalWordsPerMinute: 241,
        defaultExpectedSeconds: 67,
        sleepDelaySeconds: 22,
        semanticEventRetentionDays: 1,
      }),
    ).toMatchObject({
      petSize: 600,
      petOpacity: 30,
      dragThreshold: 7,
      doubleClickDelay: 330,
      personalWordsPerMinute: 240,
      defaultExpectedSeconds: 65,
      sleepDelaySeconds: 20,
      semanticEventRetentionDays: 7,
    });
  });

  it("accepts explicit boolean preferences", () => {
    expect(
      normalizePaperPetSettings({
        reduceMotion: true,
        trackingEnabled: false,
      }),
    ).toMatchObject({ reduceMotion: true, trackingEnabled: false });
  });
});

describe("PaperPetSettingsStore", () => {
  it("keeps the sync switch local and does not republish preferences when only toggled", async () => {
    const values = new Map<string, unknown>([
      ["user_preferences_v1", { ...DEFAULT_PAPERPET_SETTINGS, petSize: 140, syncEnabled: false }],
    ]);
    const setSetting = vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    });
    const database = {
      getSetting: async (key: string) => values.get(key),
      setSetting,
    } as unknown as PaperPetDatabase;
    const store = new PaperPetSettingsStore(database);

    const initial = await store.load();
    await store.save({ ...initial, syncEnabled: true });

    expect(values.get("sync_enabled_v1")).toBe(true);
    expect(setSetting).not.toHaveBeenCalledWith("user_preferences_v1", expect.anything());
    expect((await store.load()).petSize).toBe(140);
    expect((await store.load()).syncEnabled).toBe(true);
  });
});
