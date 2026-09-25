import { ReaderActivityController } from "./tracking/reader-activity-controller";
import { PaperPetDatabase } from "./storage/paperpet-database";
import { ReadingSessionCoordinator } from "./sessions/reading-session-coordinator";
import {
  CharacterPackInstaller,
  type InstalledCharacterPack,
} from "./packs/character-pack-installer";
import { PetOverlay } from "./ui/pet-overlay";
import {
  DashboardRepository,
  type RecentReadingItem,
} from "./dashboard/dashboard-repository";
import { DashboardView } from "./dashboard/dashboard-view";
import { GrowthService } from "./growth/growth-service";
import {
  DEFAULT_PAPERPET_SETTINGS,
  PaperPetSettingsStore,
  type PaperPetSettings,
} from "./settings/paperpet-settings";
import type {
  BackupScope,
  InstalledCharacterPackRecord,
} from "./storage/paperpet-database";

export interface CharacterPackStatus {
  state: "loading" | "loaded" | "default" | "error";
  name?: string;
  version?: string;
  installPath?: string;
  archivePath?: string;
  error?: string;
}

export interface PaperPetDiagnostics {
  lastEvent: string;
  lastEventAt: number;
  lastTitleLookup: string;
  lastTitleResult: string;
}

interface WindowCompanion {
  overlay: PetOverlay;
  controller: ReaderActivityController;
  dashboard: DashboardView;
}

export interface PublishedPreferenceAPI {
  getSettings: () => PaperPetSettings;
  previewSettings: (settings: PaperPetSettings) => void;
  saveSettings: (settings: PaperPetSettings) => Promise<PaperPetSettings>;
  openDashboard: () => Promise<void>;
  installCharacterPack: () => Promise<string | undefined>;
  getCharacterPacks: () => Promise<InstalledCharacterPackRecord[]>;
  enableCharacterPack: (packID: string) => Promise<void>;
  disableCharacterPack: () => Promise<void>;
  removeCharacterPack: (packID: string) => Promise<void>;
  getCharacterPackStatus: () => CharacterPackStatus;
  getPreviewURL: (
    mode: "idle" | "reading" | "thinking" | "annotating" | "sleeping" | "away",
  ) => string;
  resetPetPosition: () => void;
  getDiagnostics: () => PaperPetDiagnostics;
}

export class PaperPetRuntime {
  public initialized = false;

  private readonly database = new PaperPetDatabase();
  private readonly sessions = new ReadingSessionCoordinator(this.database);
  private readonly dashboardRepository = new DashboardRepository(this.database);
  private readonly growth = new GrowthService(this.database);
  private readonly settingsStore = new PaperPetSettingsStore(this.database);
  private settings: PaperPetSettings = { ...DEFAULT_PAPERPET_SETTINGS };
  private characterPackStatus: CharacterPackStatus = { state: "loading" };
  private diagnostics: PaperPetDiagnostics = {
    lastEvent: "尚未记录",
    lastEventAt: 0,
    lastTitleLookup: "尚未查询",
    lastTitleResult: "尚未查询",
  };

  private readonly companions = new Map<
    _ZoteroTypes.MainWindow,
    WindowCompanion
  >();

  public constructor(private readonly rootURI: string) {}

  public async startup(): Promise<void> {
    await Promise.all([
      Zotero.initializationPromise,
      Zotero.unlockPromise,
      Zotero.uiReadyPromise,
    ]);

    await this.database.initialize();
    this.settings = await this.settingsStore.load();
    await this.sessions.initialize();
    await this.database.pruneSemanticEvents(
      Date.now(),
      this.settings.semanticEventRetentionDays,
    );
    this.publishPreferenceAPI();

    for (const window of Zotero.getMainWindows()) {
      await this.addToWindow(window);
    }

    this.initialized = true;
    this.log("Ready");
  }

  public async addToWindow(window: _ZoteroTypes.MainWindow): Promise<void> {
    if (!window.ZoteroPane || this.companions.has(window)) {
      return;
    }

    const installer = new CharacterPackInstaller(this.database, window);
    const dashboard = new DashboardView(
      window,
      this.dashboardRepository,
      () => this.sessions.getCurrentSession(),
      () => this.growth.getSnapshot(),
      {
        onExportBackup: async (scope) => {
          const destination = await this.chooseBackupPath(window, scope);
          if (destination) {
            await this.database.exportBackup(destination, scope);
          }
        },
        onImportBackup: async (scope) => {
          const source = await this.chooseBackupSource(window, scope);
          if (source) {
            const confirmed = Services.prompt.confirm(
              window as unknown as mozIDOMWindowProxy,
              "PaperPet",
              Zotero.locale.startsWith("zh")
                ? scope === "all"
                  ? "导入完整备份将替换全部 PaperPet 本地记录、设置与角色包。建议先备份当前数据。继续导入？"
                  : scope === "reading"
                    ? "导入阅读数据将替换当前阅读记录，但不会修改设置和角色包。继续导入？"
                    : "导入设置与角色包将替换当前设置和角色包，但不会修改阅读记录。继续导入？"
                : scope === "all"
                  ? "Importing a full backup replaces all PaperPet records, settings, and packs. Continue?"
                  : scope === "reading"
                    ? "Importing reading data replaces current reading records only. Continue?"
                    : "Importing settings and packs replaces current settings and packs only. Continue?",
            );
            if (!confirmed) return;
            if (scope === "all" || scope === "reading") {
              await this.sessions.discardActiveSession();
            }
            await this.database.importBackup(source, scope);
            if (scope === "all" || scope === "settings") {
              this.applySettings(await this.settingsStore.load());
              const installer = new CharacterPackInstaller(
                this.database,
                window,
              );
              const pack = await installer.loadEnabled();
              this.applyCharacterPack(pack);
            }
          }
        },
        onExcludeSession: (sessionID, excluded) =>
          this.database.excludeSession(sessionID, excluded),
        onOpenItem: async (item) => {
          const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
            item.libraryID,
            item.attachmentKey,
          );
          if (!attachment)
            throw new Error("The Zotero attachment could not be found");
          await Zotero.FileHandlers.open(attachment);
        },
        onResolveItemTitle: (item) => this.resolveItemTitle(item),
      },
    );
    const overlay = new PetOverlay(window, this.rootURI, {
      onInteraction: () => {
        controller.recordPetInteraction();
      },
      onOpenDashboard: () => dashboard.open(),
      onOpenPreferences: () => {
        Zotero.Utilities.Internal.openPreferences("paperpet");
      },
      onAddCharacterPack: async () => {
        await this.installCharacterPack();
      },
      getCharacterPacks: () => this.getCharacterPacks(),
      onSelectCharacterPack: (packID) => this.enableCharacterPack(packID),
      onDiagnostic: (message) => this.recordDiagnostic(message),
    });
    const controller = new ReaderActivityController(
      window,
      (update) => {
        overlay.updateReadingState(update.snapshot);
        this.sessions.acceptUpdate(update);
      },
      (event) => {
        this.sessions.recordSemanticEvent(event);
      },
      this.settings,
    );
    overlay.mount();
    overlay.updateSettings(this.settings);
    try {
      const pack = await installer.loadEnabled();
      const archivePath = installer.getRememberedArchivePath();
      this.characterPackStatus = pack
        ? {
            state: "loaded",
            name: pack.manifest.name,
            version: pack.manifest.version,
            installPath: pack.installPath,
            archivePath,
          }
        : {
            state: "default",
            installPath: PathUtils.join(
              this.database.location.directoryPath,
              "packs",
            ),
            archivePath,
          };
      this.log(
        pack
          ? `Loaded character pack ${pack.manifest.id} from ${pack.installPath}`
          : "No installed character pack found; using the default character",
      );
      overlay.setCharacterPack(pack);
    } catch (error) {
      this.characterPackStatus = {
        state: "error",
        installPath: PathUtils.join(
          this.database.location.directoryPath,
          "packs",
        ),
        archivePath: installer.getRememberedArchivePath(),
        error: error instanceof Error ? error.message : String(error),
      };
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    controller.start();
    this.companions.set(window, {
      overlay,
      controller,
      dashboard,
    });
  }

  public removeFromWindow(window: _ZoteroTypes.MainWindow): void {
    const companion = this.companions.get(window);
    companion?.controller.destroy();
    companion?.overlay.destroy();
    companion?.dashboard.destroy();
    this.companions.delete(window);
  }

  public async shutdown(): Promise<void> {
    for (const { controller, overlay, dashboard } of this.companions.values()) {
      controller.destroy();
      overlay.destroy();
      dashboard.destroy();
    }
    this.companions.clear();
    this.unpublishPreferenceAPI();
    await this.sessions.shutdown();
    await this.database.close();
    this.initialized = false;
  }

  private log(message: string): void {
    Zotero.debug(`[PaperPet] ${message}`);
  }

  private applyCharacterPack(pack?: InstalledCharacterPack): void {
    for (const { overlay } of this.companions.values()) {
      overlay.setCharacterPack(pack);
    }
  }

  private applySettings(settings: PaperPetSettings): void {
    this.settings = { ...settings };
    for (const { overlay, controller } of this.companions.values()) {
      overlay.updateSettings(this.settings);
      controller.updateSettings(this.settings);
    }
  }

  private publishPreferenceAPI(): void {
    const preferenceAPI: PublishedPreferenceAPI = {
      getSettings: () => ({ ...this.settings }),
      previewSettings: (settings) => this.applySettings(settings),
      saveSettings: async (settings) => {
        const saved = await this.settingsStore.save(settings);
        this.applySettings(saved);
        await this.database.pruneSemanticEvents(
          Date.now(),
          saved.semanticEventRetentionDays,
        );
        return saved;
      },
      openDashboard: () => this.openDashboard(),
      installCharacterPack: () => this.installCharacterPack(),
      getCharacterPacks: () => this.getCharacterPacks(),
      enableCharacterPack: (packID) => this.enableCharacterPack(packID),
      disableCharacterPack: () => this.disableCharacterPack(),
      removeCharacterPack: (packID) => this.removeCharacterPack(packID),
      getCharacterPackStatus: () => ({ ...this.characterPackStatus }),
      getPreviewURL: (mode) =>
        this.companions.values().next().value?.overlay.getPreviewURL(mode) ??
        `${this.rootURI}content/paperpet-icon.png`,
      resetPetPosition: () => {
        for (const { overlay } of this.companions.values())
          overlay.resetPosition();
      },
      getDiagnostics: () => ({ ...this.diagnostics }),
    };
    (Zotero as unknown as { PaperPet?: PublishedPreferenceAPI }).PaperPet =
      preferenceAPI;
  }

  private unpublishPreferenceAPI(): void {
    delete (Zotero as unknown as { PaperPet?: PublishedPreferenceAPI })
      .PaperPet;
  }

  private async openDashboard(): Promise<void> {
    const companion = this.companions.values().next().value as
      WindowCompanion | undefined;
    if (!companion) {
      throw new Error("PaperPet is not attached to a Zotero window");
    }
    await companion.dashboard.open();
  }

  private async installCharacterPack(): Promise<string | undefined> {
    const window = this.companions.keys().next().value as
      _ZoteroTypes.MainWindow | undefined;
    if (!window) {
      throw new Error("PaperPet is not attached to a Zotero window");
    }
    const archivePath = await this.chooseCharacterPack(window);
    if (!archivePath) {
      return undefined;
    }
    const installer = new CharacterPackInstaller(this.database, window);
    try {
      const pack = await installer.install(archivePath, {
        enable: true,
        replaceExisting: true,
      });
      this.applyCharacterPack(pack);
      this.characterPackStatus = {
        state: "loaded",
        name: pack.manifest.name,
        version: pack.manifest.version,
        installPath: pack.installPath,
        archivePath,
      };
      return Zotero.locale.startsWith("zh")
        ? `角色包“${pack.manifest.name}”已安装并启用。`
        : `Character pack “${pack.manifest.name}” was installed and enabled.`;
    } catch (error) {
      this.characterPackStatus = {
        state: "error",
        installPath: PathUtils.join(
          this.database.location.directoryPath,
          "packs",
        ),
        archivePath: installer.getRememberedArchivePath(),
        error: error instanceof Error ? error.message : String(error),
      };
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async getCharacterPacks(): Promise<InstalledCharacterPackRecord[]> {
    const window = this.companions.keys().next().value as
      _ZoteroTypes.MainWindow | undefined;
    if (!window) throw new Error("PaperPet is not attached to a Zotero window");
    return new CharacterPackInstaller(this.database, window).listInstalled();
  }

  private async resolveItemTitle(
    item: RecentReadingItem,
  ): Promise<string | undefined> {
    this.diagnostics.lastTitleLookup = `${item.libraryID}/${item.itemKey} · attachment ${item.attachmentKey}`;
    this.recordDiagnostic("开始查询文献标题");
    for (const key of [item.itemKey, item.attachmentKey]) {
      let candidate: Zotero.Item | false;
      try {
        candidate = await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          key,
        );
      } catch {
        candidate = false;
      }
      if (!candidate) {
        candidate = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
      }
      if (!candidate) continue;
      let parent: Zotero.Item | false = false;
      if (candidate.parentItemID) {
        try {
          parent = await Zotero.Items.getAsync(candidate.parentItemID);
        } catch {
          parent = Zotero.Items.get(candidate.parentItemID);
        }
      }
      for (const source of [parent, candidate]) {
        if (!source) continue;
        const title = String(source.getField("title") || "").trim();
        if (title) {
          this.diagnostics.lastTitleResult = `${title}（${key === item.itemKey ? "条目" : "附件/父条目"}）`;
          this.recordDiagnostic("文献标题查询成功");
          return title;
        }
      }
    }
    this.diagnostics.lastTitleResult = "未找到标题";
    this.recordDiagnostic("文献标题查询为空");
    return undefined;
  }

  private recordDiagnostic(message: string): void {
    this.diagnostics.lastEvent = message;
    this.diagnostics.lastEventAt = Date.now();
  }

  private async enableCharacterPack(packID: string): Promise<void> {
    const window = this.companions.keys().next().value as
      _ZoteroTypes.MainWindow | undefined;
    if (!window) throw new Error("PaperPet is not attached to a Zotero window");
    const pack = await new CharacterPackInstaller(this.database, window).enable(
      packID,
    );
    this.applyCharacterPack(pack);
    this.characterPackStatus = {
      state: "loaded",
      name: pack.manifest.name,
      version: pack.manifest.version,
      installPath: pack.installPath,
      archivePath: new CharacterPackInstaller(
        this.database,
        window,
      ).getRememberedArchivePath(),
    };
  }

  private async disableCharacterPack(): Promise<void> {
    const window = this.companions.keys().next().value as
      _ZoteroTypes.MainWindow | undefined;
    if (!window) throw new Error("PaperPet is not attached to a Zotero window");
    await new CharacterPackInstaller(this.database, window).disable();
    this.applyCharacterPack(undefined);
    this.characterPackStatus = { state: "default" };
  }

  private async removeCharacterPack(packID: string): Promise<void> {
    const window = this.companions.keys().next().value as
      _ZoteroTypes.MainWindow | undefined;
    if (!window) throw new Error("PaperPet is not attached to a Zotero window");
    const installer = new CharacterPackInstaller(this.database, window);
    const current = await this.database.getEnabledPack();
    await installer.remove(packID);
    if (current?.packID === packID) {
      this.applyCharacterPack(undefined);
      this.characterPackStatus = { state: "default" };
    }
  }

  private chooseCharacterPack(
    window: _ZoteroTypes.MainWindow,
  ): Promise<string | undefined> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    picker.init(
      window.browsingContext,
      Zotero.locale.startsWith("zh")
        ? "安装 PaperPet 角色包"
        : "Install PaperPet Character Pack",
      Ci.nsIFilePicker.modeOpen,
    );
    picker.appendFilter("PaperPet Character Pack (*.zpet)", "*.zpet");
    picker.defaultExtension = "zpet";
    return new Promise((resolve) => {
      picker.open({
        done: (result) => {
          resolve(
            result === Ci.nsIFilePicker.returnCancel
              ? undefined
              : picker.file.path,
          );
        },
      });
    });
  }

  private chooseBackupPath(
    window: _ZoteroTypes.MainWindow,
    scope: BackupScope = "all",
  ): Promise<string | undefined> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    picker.init(
      window.browsingContext,
      Zotero.locale.startsWith("zh")
        ? scope === "reading"
          ? "备份 PaperPet 阅读数据"
          : scope === "settings"
            ? "备份 PaperPet 设置与角色包"
            : "备份 PaperPet 全部数据"
        : scope === "reading"
          ? "Back up PaperPet reading data"
          : scope === "settings"
            ? "Back up PaperPet settings and packs"
            : "Back up all PaperPet data",
      Ci.nsIFilePicker.modeSave,
    );
    picker.appendFilter("PaperPet backup (*.json)", "*.json");
    picker.defaultExtension = "json";
    picker.defaultString = `paperpet-${scope}-backup.json`;
    return new Promise((resolve) => {
      picker.open({
        done: (result) => {
          resolve(
            result === Ci.nsIFilePicker.returnCancel
              ? undefined
              : picker.file.path,
          );
        },
      });
    });
  }

  private chooseBackupSource(
    window: _ZoteroTypes.MainWindow,
    scope: BackupScope = "all",
  ): Promise<string | undefined> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    picker.init(
      window.browsingContext,
      Zotero.locale.startsWith("zh")
        ? scope === "reading"
          ? "导入 PaperPet 阅读数据"
          : scope === "settings"
            ? "导入 PaperPet 设置与角色包"
            : "导入 PaperPet 全部数据"
        : scope === "reading"
          ? "Restore PaperPet reading data"
          : scope === "settings"
            ? "Restore PaperPet settings and packs"
            : "Restore all PaperPet data",
      Ci.nsIFilePicker.modeOpen,
    );
    picker.appendFilter("PaperPet backup (*.json)", "*.json");
    return new Promise((resolve) => {
      picker.open({
        done: (result) => {
          resolve(
            result === Ci.nsIFilePicker.returnCancel
              ? undefined
              : picker.file.path,
          );
        },
      });
    });
  }
}
