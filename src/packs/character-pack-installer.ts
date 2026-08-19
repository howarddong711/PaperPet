import {
  CHARACTER_PACK_LIMITS,
  type CharacterPackArchiveStats,
  type CharacterPackManifest,
  isSafeCharacterPackPath,
  validateCharacterPack,
} from "./character-pack";
import { PaperPetDatabase } from "../storage/paperpet-database";

const IMAGE_PATTERN = /\.(?:apng|png|webp)$/i;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const ACTIVE_PACK_PATH_PREF = "paperpet.activePackPath";

export interface InstalledCharacterPack {
  manifest: CharacterPackManifest;
  installPath: string;
}

interface ArchiveInventory {
  entries: string[];
  directories: Set<string>;
  stats: CharacterPackArchiveStats;
  /** The archive path containing manifest.json (supports a single top-level folder). */
  manifestEntry: string;
  /** Prefix to strip when validating/installing archives wrapped in a folder. */
  rootPrefix: string;
}

export class CharacterPackInstaller {
  public constructor(
    private readonly database: PaperPetDatabase,
    private readonly window: _ZoteroTypes.MainWindow,
  ) {}

  public async install(
    archivePath: string,
    options: { enable?: boolean; replaceExisting?: boolean } = {},
  ): Promise<InstalledCharacterPack> {
    if (!archivePath.toLowerCase().endsWith(".zpet")) {
      throw new Error("Character packs must use the .zpet extension");
    }

    const archiveStat = await IOUtils.stat(archivePath);
    if ((archiveStat.size ?? 0) > CHARACTER_PACK_LIMITS.compressedBytes) {
      throw new Error("Compressed character pack exceeds 50 MB");
    }

    const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
      Ci.nsIZipReader,
    );
    const temporaryRoot = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "paperpet-zpet-",
    );
    const extractedPath = PathUtils.join(temporaryRoot, "contents");

    try {
      zipReader.open(Zotero.File.pathToFile(archivePath));
      zipReader.test("");
      const inventory = this.inventoryArchive(zipReader, archiveStat.size ?? 0);
      if (
        zipReader.getEntry(inventory.manifestEntry).realSize >
        MANIFEST_MAX_BYTES
      ) {
        throw new Error("Character pack manifest exceeds 1 MB");
      }

      await IOUtils.makeDirectory(extractedPath, { ignoreExisting: true });
      await this.extractArchive(zipReader, inventory, extractedPath);
      const contentRoot = inventory.rootPrefix
        ? PathUtils.join(extractedPath, inventory.rootPrefix.slice(0, -1))
        : extractedPath;
      const relativeEntries = inventory.entries
        .filter(
          (entry) =>
            !inventory.rootPrefix || entry.startsWith(inventory.rootPrefix),
        )
        .map((entry) =>
          inventory.rootPrefix
            ? entry.slice(inventory.rootPrefix.length)
            : entry,
        )
        .filter((entry) => entry && !entry.endsWith("/"));
      const manifest = (await IOUtils.readJSON(
        PathUtils.join(contentRoot, "manifest.json"),
      )) as unknown;
      const dimensions = await this.measureMaximumImageDimensions(
        contentRoot,
        relativeEntries,
      );
      const validation = validateCharacterPack(manifest, relativeEntries, {
        ...inventory.stats,
        ...dimensions,
      });
      if (!validation.valid || !validation.manifest) {
        throw new Error(
          `Invalid character pack:\n${validation.errors.join("\n")}`,
        );
      }

      await this.cacheArchive(archivePath, validation.manifest);

      const destination = PathUtils.join(
        this.database.location.directoryPath,
        "packs",
        validation.manifest.id,
        validation.manifest.version,
      );
      const replaceExisting = options.replaceExisting ?? false;
      if (!replaceExisting && (await IOUtils.exists(destination))) {
        throw new Error(
          `Character pack version is already installed: ${validation.manifest.id} ${validation.manifest.version}`,
        );
      }
      const destinationParent = PathUtils.parent(destination)!;
      await IOUtils.makeDirectory(destinationParent, {
        createAncestors: true,
        ignoreExisting: true,
      });

      // Keep the replacement recoverable until both the filesystem move and
      // the database upsert have completed. This makes reinstalling a pack
      // with the same id/version safe while avoiding a half-installed state.
      let backupDirectory: string | undefined;
      let backupPath: string | undefined;
      try {
        if (await IOUtils.exists(destination)) {
          backupDirectory = await IOUtils.createUniqueDirectory(
            destinationParent,
            ".paperpet-replacing-",
          );
          backupPath = PathUtils.join(backupDirectory, "previous");
          await IOUtils.move(destination, backupPath, { noOverwrite: true });
        }

        await IOUtils.move(contentRoot, destination, { noOverwrite: true });
        await this.database.saveInstalledPack({
          packID: validation.manifest.id,
          version: validation.manifest.version,
          name: validation.manifest.name,
          author: validation.manifest.author,
          license: validation.manifest.license,
          installPath: destination,
          validationJSON: JSON.stringify({
            schemaVersion: validation.manifest.schemaVersion,
            archive: inventory.stats,
            imageDimensions: dimensions,
            validatedAt: Date.now(),
          }),
          enabled: options.enable ?? true,
          installedAt: Date.now(),
        });
        this.rememberActivePack(destination);
      } catch (error) {
        await IOUtils.remove(destination, {
          recursive: true,
          ignoreAbsent: true,
        });
        if (backupPath && (await IOUtils.exists(backupPath))) {
          await IOUtils.move(backupPath, destination, { noOverwrite: true });
        }
        if (backupDirectory) {
          await IOUtils.remove(backupDirectory, {
            recursive: true,
            ignoreAbsent: true,
          });
        }
        throw error;
      }
      if (backupDirectory) {
        // Cleanup is deliberately outside the install transaction. A stale
        // backup is harmless; deleting the newly installed pack after a
        // successful database upsert would leave the database inconsistent.
        try {
          await IOUtils.remove(backupDirectory, {
            recursive: true,
            ignoreAbsent: true,
          });
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      return { manifest: validation.manifest, installPath: destination };
    } finally {
      zipReader.close();
      await IOUtils.remove(temporaryRoot, {
        recursive: true,
        ignoreAbsent: true,
      });
    }
  }

  public async loadEnabled(): Promise<InstalledCharacterPack | undefined> {
    const record = await this.database.getEnabledPack();
    let recordError: unknown;
    if (record && (await IOUtils.exists(record.installPath))) {
      try {
        const pack = await this.readInstalledPack(record.installPath);
        if (pack) {
          return pack;
        }
      } catch (error) {
        recordError = error;
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    const rememberedPath = this.getRememberedPackPath();
    if (
      rememberedPath &&
      (!record || rememberedPath !== record.installPath) &&
      (await IOUtils.exists(rememberedPath))
    ) {
      try {
        const pack = await this.readInstalledPack(rememberedPath);
        if (pack) {
          await this.database.saveInstalledPack({
            packID: pack.manifest.id,
            version: pack.manifest.version,
            name: pack.manifest.name,
            author: pack.manifest.author,
            license: pack.manifest.license,
            installPath: pack.installPath,
            validationJSON: JSON.stringify({
              schemaVersion: pack.manifest.schemaVersion,
              recoveredAt: Date.now(),
            }),
            enabled: true,
            installedAt: Date.now(),
          });
          return pack;
        }
      } catch (error) {
        recordError = error;
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    // The files are the source of truth. Recover the database row when a
    // profile migration, backup restore, or an interrupted first install left
    // the index missing or stale.
    const recovered = await this.discoverInstalledPack();
    if (recovered) {
      await this.database.saveInstalledPack({
        packID: recovered.manifest.id,
        version: recovered.manifest.version,
        name: recovered.manifest.name,
        author: recovered.manifest.author,
        license: recovered.manifest.license,
        installPath: recovered.installPath,
        validationJSON: JSON.stringify({
          schemaVersion: recovered.manifest.schemaVersion,
          recoveredAt: Date.now(),
        }),
        enabled: true,
        installedAt: Date.now(),
      });
      this.rememberActivePack(recovered.installPath);
      return recovered;
    }

    const recoveredFromArchive = await this.recoverFromArchiveCache();
    if (recoveredFromArchive) {
      return recoveredFromArchive;
    }

    if (recordError) {
      throw recordError;
    }
    return undefined;
  }

  private async readInstalledPack(
    installPath: string,
  ): Promise<InstalledCharacterPack | undefined> {
    const entries = await collectRelativeFiles(installPath);
    const candidate = (await IOUtils.readJSON(
      PathUtils.join(installPath, "manifest.json"),
    )) as unknown;
    const validation = validateCharacterPack(candidate, entries);
    if (!validation.valid || !validation.manifest) {
      throw new Error(
        `Installed character pack is no longer valid:\n${validation.errors.join("\n")}`,
      );
    }
    return { manifest: validation.manifest, installPath };
  }

  private rememberActivePack(installPath: string): void {
    try {
      Zotero.Prefs.set(ACTIVE_PACK_PATH_PREF, installPath);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private getRememberedPackPath(): string | undefined {
    try {
      const value = Zotero.Prefs.get(ACTIVE_PACK_PATH_PREF);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return undefined;
    }
  }

  private async discoverInstalledPack(): Promise<
    InstalledCharacterPack | undefined
  > {
    const packsRoot = PathUtils.join(
      this.database.location.directoryPath,
      "packs",
    );
    if (!(await IOUtils.exists(packsRoot))) {
      return undefined;
    }

    const candidates: InstalledCharacterPack[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 3) {
        return;
      }
      for (const child of await IOUtils.getChildren(directory)) {
        const stat = await IOUtils.stat(child);
        if (stat.type === "directory") {
          await visit(child, depth + 1);
          continue;
        }
        if (PathUtils.filename(child).toLowerCase() !== "manifest.json") {
          continue;
        }
        const installPath = PathUtils.parent(child);
        if (!installPath) {
          continue;
        }
        try {
          const pack = await this.readInstalledPack(installPath);
          if (pack) {
            candidates.push(pack);
          }
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    };
    await visit(packsRoot, 0);
    candidates.sort((left, right) =>
      left.installPath.localeCompare(right.installPath),
    );
    return candidates.at(-1);
  }

  private async cacheArchive(
    archivePath: string,
    manifest: CharacterPackManifest,
  ): Promise<void> {
    const cacheDirectory = PathUtils.join(
      this.database.location.directoryPath,
      "packs",
      ".archives",
    );
    const cachePath = PathUtils.join(
      cacheDirectory,
      `${manifest.id}--${manifest.version}.zpet`,
    );
    if (archivePath === cachePath) {
      return;
    }
    try {
      await IOUtils.makeDirectory(cacheDirectory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      const io = IOUtils as unknown as {
        copy: (
          source: string,
          destination: string,
          options?: { noOverwrite?: boolean },
        ) => Promise<void>;
      };
      await io.copy(archivePath, cachePath, { noOverwrite: false });
    } catch (error) {
      // The extracted pack is still persistent; cache failures should not make
      // an otherwise successful installation fail.
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async recoverFromArchiveCache(): Promise<
    InstalledCharacterPack | undefined
  > {
    const cacheDirectory = PathUtils.join(
      this.database.location.directoryPath,
      "packs",
      ".archives",
    );
    if (!(await IOUtils.exists(cacheDirectory))) {
      return undefined;
    }
    const archives: string[] = [];
    for (const child of await IOUtils.getChildren(cacheDirectory)) {
      const stat = await IOUtils.stat(child);
      if (stat.type === "regular" && child.toLowerCase().endsWith(".zpet")) {
        archives.push(child);
      }
    }
    archives.sort();
    for (const archivePath of archives.reverse()) {
      try {
        return await this.install(archivePath, {
          enable: true,
          replaceExisting: true,
        });
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return undefined;
  }

  private inventoryArchive(
    zipReader: nsIZipReader,
    compressedBytes: number,
  ): ArchiveInventory {
    const enumerator = zipReader.findEntries("*");
    const entries: string[] = [];
    const directories = new Set<string>();
    let uncompressedBytes = 0;
    let fileCount = 0;

    while (enumerator.hasMore()) {
      const name = enumerator.getNext();
      const entry = zipReader.getEntry(name);
      if (!isSafeCharacterPackPath(name)) {
        throw new Error(`Unsafe archive path: ${name}`);
      }
      if ((entry.permissions & 0o170000) === 0o120000) {
        throw new Error(`Symbolic links are not allowed: ${name}`);
      }
      entries.push(name);
      if (entry.isDirectory) {
        directories.add(name.replace(/\/$/, ""));
        continue;
      }
      fileCount += 1;
      uncompressedBytes += entry.realSize;
      if (fileCount > CHARACTER_PACK_LIMITS.fileCount) {
        throw new Error("Character pack contains more than 1000 files");
      }
      if (uncompressedBytes > CHARACTER_PACK_LIMITS.uncompressedBytes) {
        throw new Error("Uncompressed character pack exceeds 200 MB");
      }
    }

    const manifestCandidates = entries.filter(
      (entry) =>
        entry.toLowerCase().endsWith("/manifest.json") ||
        entry.toLowerCase() === "manifest.json",
    );
    if (manifestCandidates.length !== 1) {
      throw new Error("Character pack must contain exactly one manifest.json");
    }
    const manifestEntry = manifestCandidates[0];
    const rootPrefix =
      manifestEntry.toLowerCase() === "manifest.json"
        ? ""
        : manifestEntry.slice(0, -"manifest.json".length);

    return {
      entries,
      directories,
      stats: { compressedBytes, uncompressedBytes, fileCount },
      manifestEntry,
      rootPrefix,
    };
  }

  private async extractArchive(
    zipReader: nsIZipReader,
    inventory: ArchiveInventory,
    destination: string,
  ): Promise<void> {
    for (const name of inventory.entries) {
      const outputPath = joinSafeRelative(destination, name);
      if (inventory.directories.has(name.replace(/\/$/, ""))) {
        await IOUtils.makeDirectory(outputPath, {
          createAncestors: true,
          ignoreExisting: true,
        });
        continue;
      }
      const parent = PathUtils.parent(outputPath);
      if (parent) {
        await IOUtils.makeDirectory(parent, {
          createAncestors: true,
          ignoreExisting: true,
        });
      }
      zipReader.extract(name, Zotero.File.pathToFile(outputPath));
    }
  }

  private async measureMaximumImageDimensions(
    rootPath: string,
    entries: readonly string[],
  ): Promise<
    Pick<CharacterPackArchiveStats, "maximumImageWidth" | "maximumImageHeight">
  > {
    let maximumImageWidth = 0;
    let maximumImageHeight = 0;
    for (const entry of entries.filter((name) => IMAGE_PATTERN.test(name))) {
      const dimensions = await loadImageDimensions(
        this.window,
        PathUtils.toFileURI(joinSafeRelative(rootPath, entry)),
      );
      maximumImageWidth = Math.max(maximumImageWidth, dimensions.width);
      maximumImageHeight = Math.max(maximumImageHeight, dimensions.height);
      if (
        maximumImageWidth > CHARACTER_PACK_LIMITS.imageDimension ||
        maximumImageHeight > CHARACTER_PACK_LIMITS.imageDimension
      ) {
        break;
      }
    }
    return { maximumImageWidth, maximumImageHeight };
  }
}

/**
 * PathUtils.joinRelative throws NS_ERROR_FILE_UNRECOGNIZED_PATH for some
 * forward-slash paths in Windows Zotero builds. Archive paths have already
 * been validated, so joining one segment at a time is both safe and portable.
 */
function joinSafeRelative(rootPath: string, relativePath: string): string {
  const normalizedPath = relativePath.replace(/\/$/, "");
  if (!isSafeCharacterPackPath(normalizedPath)) {
    throw new Error(`Unsafe character pack relative path: ${relativePath}`);
  }
  return normalizedPath
    .split("/")
    .reduce((current, segment) => PathUtils.join(current, segment), rootPath);
}

async function collectRelativeFiles(
  rootPath: string,
  currentPath = rootPath,
): Promise<string[]> {
  const entries: string[] = [];
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  for (const child of await IOUtils.getChildren(currentPath)) {
    const stat = await IOUtils.stat(child);
    if (stat.type === "directory") {
      entries.push(...(await collectRelativeFiles(rootPath, child)));
    } else {
      const normalizedChild = child.replace(/\\/g, "/");
      const prefix = `${normalizedRoot}/`;
      const relative = normalizedChild
        .slice(
          normalizedChild.toLowerCase().startsWith(prefix.toLowerCase())
            ? prefix.length
            : normalizedChild.length,
        )
        .replace(/^\/+/, "");
      if (!relative) {
        throw new Error(`Unable to determine relative pack path: ${child}`);
      }
      entries.push(relative);
    }
  }
  return entries;
}

async function loadImageDimensions(
  window: _ZoteroTypes.MainWindow,
  uri: string,
): Promise<{ width: number; height: number }> {
  const image = window.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "img",
  ) as HTMLImageElement;
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error(`Unable to read character image: ${uri}`)),
      { once: true },
    );
    image.src = uri;
  });
  return { width: image.naturalWidth, height: image.naturalHeight };
}
