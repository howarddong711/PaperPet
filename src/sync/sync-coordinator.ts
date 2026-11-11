import { PaperPetDatabase } from "../storage/paperpet-database";
import {
  compareSyncVersion,
  createEmptySyncSnapshot,
  hashSyncPayload,
  mergeSyncSnapshots,
  type SyncCarrier,
  type SyncSnapshot,
  type SyncStatus,
} from "./sync-types";

const SYNC_DEBOUNCE_MS = 30_000;
const NOTIFY_DEBOUNCE_MS = 750;
const AUTO_PULL_MS = 60_000;

export class PaperPetSyncCoordinator {
  private status: SyncStatus = {
    code: "disabled",
    message: "同步未启用",
  };
  private deviceID = "";
  private timer?: number;
  private notifyTimer?: number;
  private pollTimer?: number;
  private timerWindow?: Window;
  private operation: Promise<void> = Promise.resolve();
  private dirty = false;
  private changeRevision = 0;
  private enabled = false;
  private observerID?: string;

  public constructor(
    private readonly database: PaperPetDatabase,
    private readonly carrier: SyncCarrier,
    private readonly onRemoteMerge?: () => Promise<void> | void,
  ) {}

  public async initialize(enabled = true): Promise<void> {
    this.deviceID = await this.database.getOrCreateDeviceID();
    if (!enabled) {
      await this.disable();
      return;
    }
    this.enabled = true;
    this.status = {
      ...this.status,
      code: "waiting",
      message: "正在检查 Zotero 同步笔记",
    };
    this.registerObserver();
    this.startAutoPull();
    try {
      await this.pull();
      await this.push(true);
    } catch {
      // An unavailable carrier must not prevent local reading.
    }
  }

  public getStatus(): SyncStatus {
    return { ...this.status };
  }

  public markDirty(): void {
    if (!this.enabled) return;
    this.dirty = true;
    this.changeRevision += 1;
    this.status = {
      ...this.status,
      code: "pending",
      message: "有本地数据等待写入 Zotero",
      lastLocalChangeAt: Date.now(),
    };
    this.schedulePush();
  }

  public async syncNow(): Promise<void> {
    if (!this.enabled) throw new Error("PaperPet 云同步未启用");
    this.clearPushTimer();
    await this.pull();
    await this.push(true);
  }

  public async readNow(): Promise<void> {
    if (!this.enabled) throw new Error("PaperPet 云同步未启用");
    const mainWindow = Zotero.getMainWindows()[0];
    mainWindow?.ZoteroPane?.sync();
    await this.pull();
    if (this.enabled && (this.status.peerCount ?? 0) === 0) {
      this.status = {
        ...this.status,
        code: "waiting",
        message: "已请求 Zotero 数据同步；等待其他设备的笔记到达",
      };
    }
  }

  public async writeNow(): Promise<void> {
    if (!this.enabled) throw new Error("PaperPet 云同步未启用");
    this.clearPushTimer();
    await this.push(true);
  }

  public pull(): Promise<void> {
    return this.enqueue(() => this.run(() => this.doPull()));
  }

  public push(force = false): Promise<void> {
    return this.enqueue(() => this.run(() => this.doPush(force)));
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const current = this.operation.then(action);
    this.operation = current.catch(() => undefined);
    return current;
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (this.enabled) {
        this.status = {
          ...this.status,
          code: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async doPull(): Promise<void> {
    if (!this.enabled) return;
    this.status = {
      ...this.status,
      code: "syncing",
      message: "正在读取 Zotero 同步笔记",
    };
    const snapshots = await this.carrier.readAll();
    const peers = new Set<string>();
    let changed = false;
    let combined = createEmptySyncSnapshot(this.deviceID, 0);
    for (const snapshot of snapshots.sort(
      (a, b) => a.exportedAt - b.exportedAt,
    )) {
      if (snapshot.exportedBy !== this.deviceID) peers.add(snapshot.exportedBy);
      combined = mergeSyncSnapshots(combined, snapshot, 0, this.deviceID);
    }
    if (snapshots.length > 0) {
      const result = await this.database.mergeSyncSnapshot(combined);
      changed = result.sessions + result.events + result.settings > 0;
    }
    if (changed) {
      await this.onRemoteMerge?.();
      this.markDirty();
    }
    const local = await this.database.exportSyncSnapshot(this.deviceID);
    if (!this.enabled) return;
    const localSessions = local.sessions.filter(
      (session) => session.deviceID === this.deviceID,
    );
    const peerSnapshots = snapshots.filter(
      (snapshot) => snapshot.exportedBy !== this.deviceID,
    );
    const peerConfirmedLocalCount = localSessions.filter((session) =>
      peerSnapshots.some((snapshot) =>
        snapshot.sessions.some(
          (seen) =>
            seen.id === session.id && compareSyncVersion(seen, session) >= 0,
        ),
      ),
    ).length;
    this.status = {
      ...this.status,
      code: this.dirty ? "pending" : "waiting",
      message: this.dirty
        ? "已合并其他设备数据，等待写入 Zotero"
        : peers.size > 0
          ? `已读取 ${peers.size} 台其他设备的数据`
          : "尚未读取到其他设备的数据",
      lastPeerSeenAt: peers.size > 0 ? Date.now() : this.status.lastPeerSeenAt,
      localSessionCount: localSessions.length,
      peerSessionCount: local.sessions.filter(
        (session) => session.deviceID !== this.deviceID,
      ).length,
      peerConfirmedLocalCount,
      peerCount: peers.size,
    };
  }

  private async doPush(force: boolean): Promise<void> {
    if (!this.enabled || (!force && !this.dirty)) return;
    this.status = {
      ...this.status,
      code: "syncing",
      message: "正在写入本机 Zotero",
    };
    const revision = this.changeRevision;
    const local = await this.database.exportSyncSnapshot(this.deviceID);
    const own = await this.carrier.readOwn(this.deviceID);
    const unchanged = own && syncContentHash(own) === syncContentHash(local);
    if (!unchanged) await this.carrier.write(this.deviceID, local);
    if (!this.enabled) return;
    if (revision === this.changeRevision) this.dirty = false;
    this.status = {
      ...this.status,
      code: this.dirty ? "pending" : "waiting",
      message: this.dirty
        ? "有本地数据等待写入 Zotero"
        : "已写入本机 Zotero；请在另一设备核对云端结果",
      lastLocalWriteAt: unchanged ? own.exportedAt : local.exportedAt,
      localSessionCount: local.sessions.filter(
        (session) => session.deviceID === this.deviceID,
      ).length,
      peerSessionCount: local.sessions.filter(
        (session) => session.deviceID !== this.deviceID,
      ).length,
    };
    if (this.dirty) this.schedulePush();
  }

  public async shutdown(): Promise<void> {
    this.clearTimer();
    await this.operation;
    if (this.dirty) await this.push();
    this.unregisterObserver();
  }

  public async disable(): Promise<void> {
    this.enabled = false;
    this.dirty = false;
    this.clearTimer();
    this.unregisterObserver();
    await this.operation;
    this.status = { code: "disabled", message: "同步未启用" };
  }

  private registerObserver(): void {
    if (this.observerID !== undefined) return;
    this.observerID = Zotero.Notifier.registerObserver(
      { notify: this.onNotify },
      ["item"],
      "paperpet-sync",
    );
  }

  private unregisterObserver(): void {
    if (this.observerID === undefined) return;
    Zotero.Notifier.unregisterObserver(this.observerID);
    this.observerID = undefined;
  }

  private readonly onNotify: _ZoteroTypes.Notifier.Notify = (
    event,
    type,
    ids,
  ): void => {
    if (
      !this.enabled ||
      type !== "item" ||
      (event !== "add" && event !== "modify")
    )
      return;
    const noteChanged = ids.some((id) => {
      const item = Zotero.Items.get(Number(id));
      return item && item.isNote();
    });
    if (!noteChanged) return;
    const window = Zotero.getMainWindows()[0] as unknown as Window | undefined;
    if (!window) {
      void this.pull().catch(() => undefined);
      return;
    }
    if (this.notifyTimer !== undefined) window.clearTimeout(this.notifyTimer);
    this.timerWindow = window;
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = undefined;
      void this.pull().catch(() => undefined);
    }, NOTIFY_DEBOUNCE_MS);
  };

  private clearTimer(): void {
    this.clearPushTimer();
    if (this.notifyTimer !== undefined) {
      this.timerWindow?.clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      this.timerWindow?.clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private startAutoPull(): void {
    const window = Zotero.getMainWindows()[0] as unknown as Window | undefined;
    if (!window || this.pollTimer !== undefined) return;
    this.timerWindow = window;
    this.pollTimer = window.setInterval(() => {
      void this.pull().catch(() => undefined);
    }, AUTO_PULL_MS);
  }

  private clearPushTimer(): void {
    if (this.timer !== undefined) {
      this.timerWindow?.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedulePush(): void {
    if (this.timer !== undefined) return;
    const window = Zotero.getMainWindows()[0] as unknown as Window | undefined;
    if (!window) return;
    this.timerWindow = window;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.push().catch(() => undefined);
    }, SYNC_DEBOUNCE_MS);
  }
}

function syncContentHash(snapshot: SyncSnapshot): string {
  return hashSyncPayload({
    format: snapshot.format,
    schemaVersion: snapshot.schemaVersion,
    exportedAt: 0,
    exportedBy: "",
    sessions: [...snapshot.sessions].sort((a, b) => a.id.localeCompare(b.id)),
    events: [...snapshot.events].sort((a, b) => a.id.localeCompare(b.id)),
    settings: [...snapshot.settings].sort((a, b) => a.key.localeCompare(b.key)),
  });
}
