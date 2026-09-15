import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ZoteroCompatibility {
  strict_min_version: string;
  strict_max_version: string;
}

interface AddonManifest {
  applications: { zotero: ZoteroCompatibility };
}

interface UpdateManifest {
  addons: Record<
    string,
    {
      updates: Array<{
        version: string;
        update_link: string;
        applications: { zotero: ZoteroCompatibility };
      }>;
    }
  >;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

describe("release compatibility metadata", () => {
  it("keeps the package, update feed, and Zotero 10 ranges aligned", () => {
    const pkg = readJson<{ version: string; config: { addonID: string } }>(
      "package.json",
    );
    const manifest = readJson<AddonManifest>("addon/manifest.json");
    const updateFeed = readJson<UpdateManifest>("update.json");
    const update = updateFeed.addons[pkg.config.addonID]?.updates[0];

    expect(update).toBeDefined();
    expect(update?.version).toBe(pkg.version);
    expect(update?.update_link).toContain(`/v${pkg.version}/PaperPet.xpi`);
    expect(manifest.applications.zotero).toMatchObject({
      strict_min_version: "10.0",
      strict_max_version: "10.*",
    });
    expect(update?.applications.zotero).toEqual({
      strict_min_version: manifest.applications.zotero.strict_min_version,
      strict_max_version: manifest.applications.zotero.strict_max_version,
    });
  });
});
