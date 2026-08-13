import { describe, expect, it } from "vitest";
import {
  CHARACTER_PACK_LIMITS,
  resolveCharacterAction,
  validateCharacterPack,
} from "../src/packs/character-pack";

const minimalManifest = {
  schemaVersion: 1,
  id: "org.paperpet.test-companion",
  name: "Test Companion",
  version: "0.1.0",
  author: "PaperPet",
  license: "CC0-1.0",
  renderer: "static-image",
  actions: {
    idle: { asset: "assets/common/idle.png" },
    reading: { asset: "assets/common/reading.png" },
    thinking: { asset: "assets/common/thinking.png" },
    sleeping: { asset: "assets/common/sleeping.png" },
  },
};

const entries = [
  "manifest.json",
  "assets/common/idle.png",
  "assets/common/reading.png",
  "assets/common/thinking.png",
  "assets/common/sleeping.png",
];

describe("validateCharacterPack", () => {
  it("accepts the four-action minimum package", () => {
    const result = validateCharacterPack(minimalManifest, entries);
    expect(result.valid).toBe(true);
    expect(result.manifest?.id).toBe("org.paperpet.test-companion");
  });

  it("rejects missing required actions and missing assets", () => {
    const result = validateCharacterPack(
      {
        ...minimalManifest,
        actions: {
          ...minimalManifest.actions,
          reading: { asset: "assets/common/missing.png" },
          thinking: undefined,
        },
      },
      entries,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("missing.png");
    expect(result.errors.join("\n")).toContain("thinking[0]");
  });

  it("rejects path traversal and executable package content", () => {
    const result = validateCharacterPack(minimalManifest, [
      ...entries,
      "../../bootstrap.js",
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unsafe archive path");
    expect(result.errors.join("\n")).toContain("executable content");
  });

  it("rejects identifiers that could escape the installation directory", () => {
    const result = validateCharacterPack(
      { ...minimalManifest, id: "../../outside", version: "../1" },
      entries,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("id contains unsupported");
    expect(result.errors.join("\n")).toContain("version contains unsupported");
  });

  it("enforces archive, image, and frame-rate budgets", () => {
    const result = validateCharacterPack(
      {
        ...minimalManifest,
        actions: {
          ...minimalManifest.actions,
          reading: {
            asset: "assets/common/reading.png",
            framesPerSecond: 60,
          },
        },
      },
      entries,
      {
        compressedBytes: CHARACTER_PACK_LIMITS.compressedBytes + 1,
        uncompressedBytes: CHARACTER_PACK_LIMITS.uncompressedBytes + 1,
        fileCount: CHARACTER_PACK_LIMITS.fileCount + 1,
        maximumImageWidth: CHARACTER_PACK_LIMITS.imageDimension + 1,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("50 MB");
    expect(result.errors.join("\n")).toContain("200 MB");
    expect(result.errors.join("\n")).toContain("1000 files");
    expect(result.errors.join("\n")).toContain("4096 px");
    expect(result.errors.join("\n")).toContain("between 1 and 30");
  });
});

describe("resolveCharacterAction", () => {
  it("falls annotating and skimming back to reading", () => {
    const validated = validateCharacterPack(minimalManifest, entries);
    const manifest = validated.manifest!;
    expect(resolveCharacterAction(manifest, "annotating").resolvedAction).toBe(
      "reading",
    );
    expect(resolveCharacterAction(manifest, "skimming").resolvedAction).toBe(
      "reading",
    );
  });

  it("falls an unknown custom action back to idle", () => {
    const validated = validateCharacterPack(minimalManifest, entries);
    expect(
      resolveCharacterAction(validated.manifest!, "studying-equations")
        .resolvedAction,
    ).toBe("idle");
  });
});
