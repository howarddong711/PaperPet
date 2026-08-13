import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPERPET_SETTINGS,
  normalizePaperPetSettings,
} from "../src/settings/paperpet-settings";

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
        petSize: 500,
        petOpacity: 12,
        dragThreshold: 7.4,
        doubleClickDelay: 333,
        personalWordsPerMinute: 241,
        defaultExpectedSeconds: 67,
        sleepDelaySeconds: 22,
        semanticEventRetentionDays: 1,
      }),
    ).toMatchObject({
      petSize: 220,
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
