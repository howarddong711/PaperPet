import type {
  ReadingActivitySnapshot,
  ReadingMode,
} from "../model/reading-activity-model";
import {
  readingModeToCharacterAction,
  resolveCharacterAction,
  type CharacterPackManifest,
} from "../packs/character-pack";
import type { PaperPetSettings } from "../settings/paperpet-settings";
import { hasCrossedDragThreshold } from "./pointer-gesture";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OVERLAY_ID = "paperpet-overlay";
const COMPANION_ID = "paperpet-companion";
const BUBBLE_ID = "paperpet-bubble";
const STYLESHEET_ID = "paperpet-stylesheet";

export interface CharacterPackPresentation {
  manifest: CharacterPackManifest;
  installPath: string;
}

interface PetOverlayActions {
  onInteraction: () => void;
  onOpenDashboard: () => Promise<void>;
  onOpenPreferences: () => void;
  onAddCharacterPack: () => Promise<void>;
  getCharacterPacks: () => Promise<
    Array<{ packID: string; name: string; version: string; enabled: boolean }>
  >;
  onSelectCharacterPack: (packID: string) => Promise<void>;
  onDiagnostic: (message: string) => void;
}

interface DragState {
  pointerID: number;
  originX: number;
  originY: number;
  startLeft: number;
  startTop: number;
  moved: boolean;
}

export class PetOverlay {
  private overlay?: HTMLDivElement;
  private companion?: HTMLDivElement;
  private bubble?: HTMLDivElement;
  private contextMenu?: HTMLDivElement;
  private characterImage?: HTMLImageElement;
  private stylesheet?: HTMLLinkElement;
  private dragState?: DragState;
  private clickTimer?: number;
  private bubbleTimer?: number;
  private snapshot?: ReadingActivitySnapshot;
  private characterPack?: CharacterPackPresentation;
  private settings?: PaperPetSettings;

  public constructor(
    private readonly window: _ZoteroTypes.MainWindow,
    private readonly rootURI: string,
    private readonly actions: PetOverlayActions,
  ) {}

  public mount(): void {
    const { document } = this.window;
    if (document.getElementById(OVERLAY_ID)) {
      return;
    }

    this.stylesheet = this.createElement("link");
    this.stylesheet.id = STYLESHEET_ID;
    this.stylesheet.rel = "stylesheet";
    this.stylesheet.type = "text/css";
    this.stylesheet.href = `${this.rootURI}content/paperpet.css`;

    this.overlay = this.createElement("div");
    this.overlay.id = OVERLAY_ID;

    // Use a plain div rather than a native button. In Zotero's mixed XUL/HTML
    // window, native button hit testing can shrink to the painted artwork;
    // PaperPet needs the entire square to be one stable drag target.
    this.companion = this.createElement("div");
    this.companion.id = COMPANION_ID;
    this.companion.setAttribute("role", "button");
    this.companion.tabIndex = 0;
    this.companion.title = this.copy(
      "PaperPet 正在等待阅读",
      "PaperPet is waiting",
    );
    this.companion.dataset.mode = "idle";
    this.companion.setAttribute(
      "aria-label",
      this.copy("与 PaperPet 互动", "Interact with PaperPet"),
    );

    const placeholder = this.createElement("span");
    placeholder.className = "paperpet-placeholder__sheet";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "P";
    this.companion.appendChild(placeholder);

    this.characterImage = this.createElement("img");
    this.characterImage.className = "paperpet-character";
    this.characterImage.alt = "";
    this.characterImage.setAttribute("aria-hidden", "true");
    this.characterImage.hidden = true;
    this.companion.appendChild(this.characterImage);

    // Keep one stable, full-size hit target above every character asset. Some
    // role images contain transparent pixels or animated content; pointer
    // handling must belong to the pet as a whole, not to a particular frame.
    const hitArea = this.createElement("span");
    hitArea.className = "paperpet-companion__hit-area";
    hitArea.setAttribute("aria-hidden", "true");
    this.companion.appendChild(hitArea);

    this.bubble = this.createElement("div");
    this.bubble.id = BUBBLE_ID;
    this.bubble.setAttribute("role", "status");
    this.bubble.setAttribute("aria-live", "polite");
    this.bubble.dataset.visible = "false";

    const bubbleTitle = this.createElement("strong");
    bubbleTitle.className = "paperpet-bubble__title";
    bubbleTitle.textContent = "PaperPet";

    const bubbleBody = this.createElement("span");
    bubbleBody.className = "paperpet-bubble__body";
    bubbleBody.textContent = this.copy(
      "打开一篇文献开始阅读，我会安静地陪着你。",
      "Open a paper and start reading. I will stay quietly with you.",
    );

    this.bubble.append(bubbleTitle, bubbleBody);

    this.contextMenu = this.createContextMenu();

    this.overlay.append(this.bubble, this.contextMenu, this.companion);
    document.documentElement?.append(this.stylesheet, this.overlay);

    this.companion.addEventListener("pointerdown", this.onPointerDown, true);
    this.companion.addEventListener("pointermove", this.onPointerMove, true);
    this.companion.addEventListener("pointerup", this.onPointerUp, true);
    this.companion.addEventListener(
      "pointercancel",
      this.onPointerCancel,
      true,
    );
    this.companion.addEventListener("click", this.onKeyboardClick);
    this.companion.addEventListener("contextmenu", this.onContextMenu);
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("pointermove", this.onPointerMove, true);
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("pointercancel", this.onPointerCancel, true);
    this.window.addEventListener("pointerdown", this.onCloseContextMenu, true);
    this.window.addEventListener("mousedown", this.onCloseContextMenu, true);
    this.window.addEventListener("click", this.onCloseContextMenu, true);
  }

  public updateSettings(settings: PaperPetSettings): void {
    this.settings = settings;
    if (!this.companion) {
      return;
    }
    // Set concrete dimensions as well as CSS variables. Zotero's mixed XUL/
    // HTML document can ignore custom properties on dynamically-created nodes.
    this.companion.style.width = `${settings.petSize}px`;
    this.companion.style.height = `${settings.petSize}px`;
    this.companion.style.opacity = String(settings.petOpacity / 100);
    this.companion.style.setProperty(
      "--paperpet-size",
      `${settings.petSize}px`,
    );
    this.companion.style.setProperty(
      "--paperpet-opacity",
      String(settings.petOpacity / 100),
    );
    this.companion.dataset.reduceMotion = String(settings.reduceMotion);
    this.keepInsideWindow();
  }

  public setCharacterPack(pack?: CharacterPackPresentation): void {
    this.characterPack = pack;
    this.renderCharacterAction(this.snapshot?.mode ?? "idle");
  }

  public resetPosition(): void {
    if (!this.companion) return;
    this.dragState = undefined;
    this.companion.dataset.dragging = "false";
    this.companion.style.left = "auto";
    this.companion.style.top = "auto";
    this.companion.style.right = "24px";
    this.companion.style.bottom = "22px";
    this.keepInsideWindow();
  }

  public getPreviewURL(
    mode: "idle" | "reading" | "thinking" | "annotating" | "sleeping" | "away",
  ): string {
    if (!this.characterPack) return `${this.rootURI}content/paperpet-icon.png`;
    const resolved = resolveCharacterAction(
      this.characterPack.manifest,
      readingModeToCharacterAction(mode),
    );
    const asset = resolved.variants[0].asset;
    if (!/\.(?:apng|png|webp)$/i.test(asset))
      return `${this.rootURI}content/paperpet-icon.png`;
    return PathUtils.toFileURI(
      asset
        .split("/")
        .reduce(
          (path, segment) => PathUtils.join(path, segment),
          this.characterPack.installPath,
        ),
    );
  }

  public updateReadingState(snapshot: ReadingActivitySnapshot): void {
    this.snapshot = snapshot;
    if (!this.companion) {
      return;
    }

    const mode = this.modeCopy(snapshot.mode);
    this.companion.dataset.mode = snapshot.mode;
    this.renderCharacterAction(snapshot.mode);
    this.companion.title = this.copy(
      `PaperPet 当前状态：${mode.chinese}`,
      `PaperPet is ${mode.english}`,
    );
    this.companion.setAttribute(
      "aria-label",
      this.copy(
        `与 PaperPet 互动，当前${mode.chinese}`,
        `Interact with PaperPet, currently ${mode.english}`,
      ),
    );
  }

  public destroy(): void {
    this.companion?.removeEventListener(
      "pointerdown",
      this.onPointerDown,
      true,
    );
    this.companion?.removeEventListener(
      "pointermove",
      this.onPointerMove,
      true,
    );
    this.companion?.removeEventListener("pointerup", this.onPointerUp, true);
    this.companion?.removeEventListener(
      "pointercancel",
      this.onPointerCancel,
      true,
    );
    this.companion?.removeEventListener("click", this.onKeyboardClick);
    this.companion?.removeEventListener("contextmenu", this.onContextMenu);
    this.window.document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
    this.window.document.removeEventListener(
      "pointermove",
      this.onPointerMove,
      true,
    );
    this.window.document.removeEventListener(
      "pointerup",
      this.onPointerUp,
      true,
    );
    this.window.document.removeEventListener(
      "pointercancel",
      this.onPointerCancel,
      true,
    );
    this.window.removeEventListener(
      "pointerdown",
      this.onCloseContextMenu,
      true,
    );
    this.window.removeEventListener("mousedown", this.onCloseContextMenu, true);
    this.window.removeEventListener("click", this.onCloseContextMenu, true);

    if (this.clickTimer !== undefined) {
      this.window.clearTimeout(this.clickTimer);
    }
    if (this.bubbleTimer !== undefined) {
      this.window.clearTimeout(this.bubbleTimer);
    }

    this.overlay?.remove();
    this.stylesheet?.remove();
    this.overlay = undefined;
    this.companion = undefined;
    this.bubble = undefined;
    this.contextMenu = undefined;
    this.characterImage = undefined;
    this.stylesheet = undefined;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.companion) {
      return;
    }

    const rect = this.companion.getBoundingClientRect();
    this.companion.style.right = "auto";
    this.companion.style.bottom = "auto";
    this.companion.style.left = `${rect.left}px`;
    this.companion.style.top = `${rect.top}px`;
    this.companion.dataset.dragging = "true";

    this.dragState = {
      pointerID: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
    };
    this.companion.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.companion) {
      return;
    }
    const target = event.target as Node | null;
    if (target && this.contextMenu?.contains(target)) {
      return;
    }
    if (target && this.companion.contains(target)) {
      return;
    }
    const rect = this.companion.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (inside) {
      this.onPointerDown(event);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragState || !this.companion || !this.overlay) {
      return;
    }
    if (event.pointerId !== this.dragState.pointerID) {
      return;
    }

    const deltaX = event.clientX - this.dragState.originX;
    const deltaY = event.clientY - this.dragState.originY;
    const threshold = this.settings?.dragThreshold ?? 6;
    if (hasCrossedDragThreshold(deltaX, deltaY, threshold)) {
      this.dragState.moved = true;
    }

    if (!this.dragState.moved) {
      return;
    }

    const maxLeft = Math.max(
      0,
      this.overlay.clientWidth - this.companion.offsetWidth,
    );
    const maxTop = Math.max(
      0,
      this.overlay.clientHeight - this.companion.offsetHeight,
    );
    const nextLeft = this.clamp(this.dragState.startLeft + deltaX, 0, maxLeft);
    const nextTop = this.clamp(this.dragState.startTop + deltaY, 0, maxTop);

    this.companion.style.left = `${nextLeft}px`;
    this.companion.style.top = `${nextTop}px`;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragState || !this.companion) {
      return;
    }
    if (event.pointerId !== this.dragState.pointerID) {
      return;
    }
    const moved = this.dragState.moved;
    this.dragState = undefined;
    this.companion.dataset.dragging = "false";
    if (this.companion.hasPointerCapture(event.pointerId)) {
      this.companion.releasePointerCapture(event.pointerId);
    }
    if (!moved) {
      this.registerPrimaryClick();
    }
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.dragState?.pointerID !== event.pointerId) {
      return;
    }
    this.dragState = undefined;
    if (this.companion) {
      this.companion.dataset.dragging = "false";
    }
  };

  private readonly onKeyboardClick = (event: MouseEvent): void => {
    if (event.detail === 0) {
      this.registerPrimaryClick();
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.contextMenu || !this.overlay) return;
    const menuWidth = 220;
    const menuHeight = 270;
    this.contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, this.overlay.clientWidth - menuWidth - 8))}px`;
    this.contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, this.overlay.clientHeight - menuHeight - 8))}px`;
    this.contextMenu.dataset.visible = "true";
    this.actions.onDiagnostic("菜单打开");
  };

  private readonly onCloseContextMenu = (event: MouseEvent): void => {
    if (!this.contextMenu || this.contextMenu.dataset.visible !== "true")
      return;
    if (event.target instanceof Node && this.contextMenu.contains(event.target))
      return;

    const rect = this.contextMenu.getBoundingClientRect();
    const insideMenu =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (insideMenu) return;

    this.contextMenu.dataset.visible = "false";
    this.actions.onDiagnostic("菜单因点击外部关闭");
  };

  private createContextMenu(): HTMLDivElement {
    const menu = this.createElement("div");
    menu.className = "paperpet-context-menu";
    menu.dataset.visible = "false";
    menu.setAttribute("role", "menu");
    menu.addEventListener("pointerdown", (event) => event.stopPropagation());
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("pointerleave", this.onContextMenuLeave);
    menu.addEventListener("mouseleave", this.onContextMenuLeave);
    const report = this.createMenuItem(
      this.copy("打开阅读报告", "Open reading report"),
      () => this.actions.onOpenDashboard(),
    );
    const switchPack = this.createPackMenuItem();
    const addPack = this.createMenuItem(
      this.copy("添加角色包", "Add character pack"),
      () => this.actions.onAddCharacterPack(),
    );
    const settings = this.createMenuItem(
      this.copy("打开 PaperPet 设置", "Open PaperPet settings"),
      async () => this.actions.onOpenPreferences(),
    );
    menu.append(report, switchPack, addPack, settings);
    return menu;
  }

  private readonly onContextMenuLeave = (): void => {
    if (!this.contextMenu || this.contextMenu.dataset.visible !== "true") {
      return;
    }
    this.contextMenu.dataset.visible = "false";
    this.actions.onDiagnostic("菜单因鼠标移出关闭");
  };

  private createPackMenuItem(): HTMLDivElement {
    const wrapper = this.createElement("div");
    wrapper.className = "paperpet-context-menu__group";
    const trigger = this.createElement("button");
    trigger.type = "button";
    trigger.className = "paperpet-context-menu__item";
    trigger.textContent = this.copy("切换角色包", "Switch character pack");
    const submenu = this.createElement("div");
    submenu.className = "paperpet-context-menu__submenu";
    submenu.hidden = true;
    trigger.addEventListener("click", async (event) => {
      event.stopPropagation();
      this.actions.onDiagnostic("点击切换角色包");
      if (!submenu.hidden) {
        submenu.hidden = true;
        return;
      }
      submenu.replaceChildren();
      let packs: Awaited<ReturnType<PetOverlayActions["getCharacterPacks"]>>;
      try {
        packs = await this.actions.getCharacterPacks();
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      if (packs.length === 0) {
        const empty = this.createElement("span");
        empty.className = "paperpet-context-menu__empty";
        empty.textContent = this.copy(
          "还没有添加角色包",
          "No character packs added",
        );
        submenu.appendChild(empty);
      } else {
        for (const pack of packs) {
          const option = this.createElement("button");
          option.type = "button";
          option.className = "paperpet-context-menu__item";
          option.textContent = `${pack.name} · ${pack.version}${pack.enabled ? this.copy(" · 当前", " · Active") : ""}`;
          option.addEventListener("click", () => {
            submenu.hidden = true;
            this.contextMenu!.dataset.visible = "false";
            this.actions.onDiagnostic(`选择角色包：${pack.name}`);
            void this.actions
              .onSelectCharacterPack(pack.packID)
              .catch((error) =>
                Zotero.logError(
                  error instanceof Error ? error : new Error(String(error)),
                ),
              );
          });
          submenu.appendChild(option);
        }
      }
      submenu.hidden = false;
    });
    wrapper.append(trigger, submenu);
    return wrapper;
  }

  private createMenuItem(
    label: string,
    action?: () => Promise<void> | void,
    disabled = false,
  ): HTMLButtonElement {
    const item = this.createElement("button");
    item.type = "button";
    item.className = "paperpet-context-menu__item";
    item.textContent = label;
    item.disabled = disabled;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      this.contextMenu!.dataset.visible = "false";
      this.actions.onDiagnostic(`点击菜单：${label}`);
      if (action)
        void Promise.resolve(action()).catch((error) => Zotero.logError(error));
    });
    return item;
  }

  private registerPrimaryClick(): void {
    if (this.clickTimer !== undefined) {
      this.window.clearTimeout(this.clickTimer);
      this.clickTimer = undefined;
      this.actions.onInteraction();
      this.showBubble(this.currentStateMessage());
      return;
    }
    this.clickTimer = this.window.setTimeout(() => {
      this.clickTimer = undefined;
      this.actions.onInteraction();
      this.showBubble(this.currentStateMessage());
    }, this.settings?.doubleClickDelay ?? 260);
  }

  private renderCharacterAction(mode: ReadingMode): void {
    if (!this.characterImage) {
      return;
    }
    const placeholder = this.companion?.querySelector<HTMLElement>(
      ".paperpet-placeholder__sheet",
    );
    if (!this.characterPack) {
      this.characterImage.hidden = true;
      if (placeholder) {
        placeholder.hidden = false;
      }
      return;
    }

    const resolved = resolveCharacterAction(
      this.characterPack.manifest,
      readingModeToCharacterAction(mode),
    );
    const variant = resolved.variants[0];
    if (!/\.(?:apng|png|webp)$/i.test(variant.asset)) {
      this.characterImage.hidden = true;
      if (placeholder) {
        placeholder.hidden = false;
      }
      return;
    }
    this.characterImage.src = PathUtils.toFileURI(
      variant.asset
        .split("/")
        .reduce(
          (current, segment) => PathUtils.join(current, segment),
          this.characterPack.installPath,
        ),
    );
    this.characterImage.hidden = false;
    if (placeholder) {
      placeholder.hidden = true;
    }
  }

  private currentStateMessage(): string {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return this.copy(
        "打开一篇文献开始阅读，我会安静地陪着你。",
        "Open a paper and start reading. I will stay quietly with you.",
      );
    }

    const mode = this.modeCopy(snapshot.mode);
    const duration = this.formatDuration(snapshot.effectiveReadingSeconds);
    return this.copy(
      `我现在${mode.chinese}。本次已识别 ${duration} 的有效阅读。`,
      `I am ${mode.english}. ${duration} of effective reading recognized this session.`,
    );
  }

  private modeCopy(mode: ReadingMode): { chinese: string; english: string } {
    const labels: Record<ReadingMode, { chinese: string; english: string }> = {
      away: { chinese: "在等你回来", english: "waiting for you" },
      idle: { chinese: "等待阅读", english: "waiting to read" },
      reading: { chinese: "陪你阅读", english: "reading with you" },
      thinking: { chinese: "陪你思考", english: "thinking with you" },
      skimming: { chinese: "跟着你快速浏览", english: "skimming with you" },
      annotating: {
        chinese: "帮你守着批注",
        english: "watching your annotations",
      },
      uncertain: { chinese: "留意你的阅读", english: "noticing your reading" },
      sleeping: { chinese: "安静睡着了", english: "quietly asleep" },
    };
    return labels[mode];
  }

  private formatDuration(totalSeconds: number): string {
    const roundedSeconds = Math.max(0, Math.round(totalSeconds));
    const minutes = Math.floor(roundedSeconds / 60);
    const seconds = roundedSeconds % 60;
    if (Zotero.locale.startsWith("zh")) {
      return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
    }
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  private showBubble(message: string): void {
    if (!this.bubble || !this.companion || !this.overlay) {
      return;
    }

    const body = this.bubble.querySelector(".paperpet-bubble__body");
    if (body) {
      body.textContent = message;
    }
    const petRect = this.companion.getBoundingClientRect();
    const bubbleRect = this.bubble.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(petRect.left, this.overlay.clientWidth - bubbleRect.width - 8),
    );
    const top =
      petRect.top - bubbleRect.height - 12 >= 8
        ? petRect.top - bubbleRect.height - 12
        : Math.min(
            this.overlay.clientHeight - bubbleRect.height - 8,
            petRect.bottom + 12,
          );
    this.bubble.style.left = `${left}px`;
    this.bubble.style.top = `${Math.max(8, top)}px`;
    this.bubble.dataset.visible = "true";

    if (this.bubbleTimer !== undefined) {
      this.window.clearTimeout(this.bubbleTimer);
    }
    this.bubbleTimer = this.window.setTimeout(() => {
      if (this.bubble) {
        this.bubble.dataset.visible = "false";
      }
    }, 3600);
  }

  private createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
  ): HTMLElementTagNameMap[K] {
    return this.window.document.createElementNS(
      XHTML_NS,
      tagName,
    ) as unknown as HTMLElementTagNameMap[K];
  }

  private copy(chinese: string, english: string): string {
    return Zotero.locale.startsWith("zh") ? chinese : english;
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
  }

  private keepInsideWindow(): void {
    if (!this.companion || !this.overlay) {
      return;
    }
    const rect = this.companion.getBoundingClientRect();
    if (!this.companion.style.left && !this.companion.style.top) {
      return;
    }
    const maximumLeft = Math.max(0, this.overlay.clientWidth - rect.width);
    const maximumTop = Math.max(0, this.overlay.clientHeight - rect.height);
    this.companion.style.left = `${this.clamp(rect.left, 0, maximumLeft)}px`;
    this.companion.style.top = `${this.clamp(rect.top, 0, maximumTop)}px`;
  }
}
