import { ReaderActivityController } from "./tracking/reader-activity-controller";
import { PaperPetDatabase } from "./storage/paperpet-database";
import { ReadingSessionCoordinator } from "./sessions/reading-session-coordinator";
import {
  CharacterPackInstaller,
  type InstalledCharacterPack,
} from "./packs/character-pack-installer";
import { PetOverlay } from "./ui/pet-overlay";
import { DashboardRepository } from "./dashboard/dashboard-repository";
import { DashboardView } from "./dashboard/dashboard-view";
import { GrowthService } from "./growth/growth-service";
import {
  DEFAULT_PAPERPET_SETTINGS,
  PaperPetSettingsStore,
  type PaperPetSettings,
} from "./settings/paperpet-settings";

export interface CharacterPackStatus {
  state: "loading" | "loaded" | "default" | "error";
  name?: string;
  version?: string;
  installPath?: string;
  error?: string;
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
  getCharacterPackStatus: () => CharacterPackStatus;
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
        onExportBackup: async () => {
          const destination = await this.chooseBackupPath(window);
          if (destination) {
            await this.database.exportBackup(destination);
          }
        },
        onImportBackup: async () => {
          const source = await this.chooseBackupSource(window);
          if (source) {
            await this.sessions.discardActiveSession();
            await this.database.importBackup(source);
          }
        },
        onClearData: async () => {
          const confirmed = Services.prompt.confirm(
            window as unknown as mozIDOMWindowProxy,
            "PaperPet",
            Zotero.locale.startsWith("zh")
              ? "清空 PaperPet 的本地阅读记录？此操作不会删除 Zotero 文献。"
              : "Clear PaperPet's local reading records? Zotero items will not be deleted.",
          );
          if (confirmed) {
            await this.sessions.clearData();
          }
        },
        onExcludeSession: (sessionID, excluded) =>
          this.database.excludeSession(sessionID, excluded),
      },
    );
    const overlay = new PetOverlay(window, this.rootURI, {
      onInteraction: () => {
        controller.recordPetInteraction();
      },
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
      this.characterPackStatus = pack
        ? {
            state: "loaded",
            name: pack.manifest.name,
            version: pack.manifest.version,
            installPath: pack.installPath,
          }
        : {
            state: "default",
            installPath: PathUtils.join(
              this.database.location.directoryPath,
              "packs",
            ),
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

  private applyCharacterPack(pack: InstalledCharacterPack): void {
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
      getCharacterPackStatus: () => ({ ...this.characterPackStatus }),
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
        error: error instanceof Error ? error.message : String(error),
      };
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
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
  ): Promise<string | undefined> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    picker.init(
      window.browsingContext,
      Zotero.locale.startsWith("zh")
        ? "备份 PaperPet 阅读记录"
        : "Back up PaperPet data",
      Ci.nsIFilePicker.modeSave,
    );
    picker.appendFilter("PaperPet backup (*.json)", "*.json");
    picker.defaultExtension = "json";
    picker.defaultString = "paperpet-backup.json";
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
  ): Promise<string | undefined> {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker,
    );
    picker.init(
      window.browsingContext,
      Zotero.locale.startsWith("zh")
        ? "导入 PaperPet 阅读记录"
        : "Restore PaperPet data",
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
