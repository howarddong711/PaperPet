import {
  calculateForegroundGate,
  type ContentSample,
  ReadingActivityModel,
  type ReadingActivityModelOptions,
  type ReadingActivitySnapshot,
  type ReadingSignal,
} from "../model/reading-activity-model";
import type { PaperPetSettings } from "../settings/paperpet-settings";

export interface ReaderItemIdentity {
  libraryID: number;
  itemKey: string;
  attachmentKey: string;
  title: string;
}

export interface ReadingActivityUpdate {
  snapshot: ReadingActivitySnapshot;
  observedAt: number;
  item?: ReaderItemIdentity;
}

export interface SemanticReadingEvent {
  type: Exclude<ReadingSignal, "mouse-move" | "pet-interaction">;
  observedAt: number;
  pageIndex?: number;
}

type SnapshotListener = (update: ReadingActivityUpdate) => void;
type SemanticEventListener = (event: SemanticReadingEvent) => void;

interface ReaderViewAdapter {
  _iframeWindow?: Window;
}

interface InternalReaderAdapter {
  _primaryView?: ReaderViewAdapter;
  _secondaryView?: ReaderViewAdapter;
}

interface ReaderAdapter extends _ZoteroTypes.ReaderInstance {
  _internalReader: InternalReaderAdapter &
    _ZoteroTypes.Reader.InternalReader<"pdf" | "epub" | "snapshot">;
}

interface BoundTarget {
  target: Window | Document;
  type: string;
  listener: EventListener;
  options?: AddEventListenerOptions | boolean;
}

const NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

const STRONG_SIGNAL_THROTTLE_MS = 350;
const CONTENT_SAMPLE_THROTTLE_MS = 2_000;
const WEAK_SIGNAL_THROTTLE_MS = 2_000;

/**
 * Keeps Zotero-specific reader internals at the edge of the application. The
 * model itself remains deterministic and can be tested without Zotero.
 */
export class ReaderActivityController {
  private readonly model: ReadingActivityModel;
  private readonly boundTargets: BoundTarget[] = [];
  private readonly lastSignalAt = new Map<ReadingSignal, number>();
  private observerID?: string;
  private intervalID?: number;
  private activeReader?: ReaderAdapter;
  private activeTabID?: string;
  private lastContentSample: ContentSample = {};
  private lastContentSampleAt = 0;

  public constructor(
    private readonly window: _ZoteroTypes.MainWindow,
    private readonly onSnapshot: SnapshotListener,
    private readonly onSemanticEvent?: SemanticEventListener,
    private settings?: PaperPetSettings,
  ) {
    this.model = new ReadingActivityModel(this.modelOptions());
  }

  public updateSettings(settings: PaperPetSettings): void {
    this.settings = settings;
    this.model.updateOptions(this.modelOptions());
    this.publishSnapshot(Date.now());
  }

  public start(): void {
    if (this.intervalID !== undefined) {
      return;
    }

    this.observerID = Zotero.Notifier.registerObserver(
      { notify: this.onNotify },
      ["tab", "file", "item"],
      "paperpet-reading-activity",
    );
    this.refreshReader();
    this.publishTick();
    this.intervalID = this.window.setInterval(this.publishTick, 1_000);
  }

  public destroy(): void {
    if (this.intervalID !== undefined) {
      this.window.clearInterval(this.intervalID);
      this.intervalID = undefined;
    }
    if (this.observerID !== undefined) {
      Zotero.Notifier.unregisterObserver(this.observerID);
      this.observerID = undefined;
    }
    this.unbindReaderTargets();
    this.activeReader = undefined;
    this.activeTabID = undefined;
  }

  public recordPetInteraction(): void {
    this.recordSignal("pet-interaction", Date.now());
  }

  private readonly publishTick = (): void => {
    this.refreshReader();
    const observedAt = Date.now();
    this.publishSnapshot(observedAt);
  };

  private readonly onNotify: _ZoteroTypes.Notifier.Notify = (
    event,
    type,
    ids,
  ): void => {
    if (type === "tab") {
      this.refreshReader();
      return;
    }

    if (type === "file" && String(event) === "pageChange") {
      if (ids.some((id) => String(id) === String(this.activeReader?.itemID))) {
        this.recordSignal("page-change", Date.now());
      }
      return;
    }

    if (type !== "item" || (event !== "add" && event !== "modify")) {
      return;
    }

    const attachmentID = this.activeReader?.itemID;
    if (attachmentID === undefined) {
      return;
    }

    for (const id of ids) {
      const numericID = typeof id === "number" ? id : Number(id);
      if (!Number.isFinite(numericID)) {
        continue;
      }
      const item = Zotero.Items.get(numericID);
      if (item && item.isAnnotation() && item.parentItemID === attachmentID) {
        this.recordSignal("annotation", Date.now());
        break;
      }
    }
  };

  private refreshReader(): void {
    const { Zotero_Tabs: tabs } = this.window;
    const tabID = tabs.selectedType === "reader" ? tabs.selectedID : undefined;
    const reader = tabID
      ? (Zotero.Reader.getByTabID(tabID) as ReaderAdapter | undefined)
      : undefined;
    const targetsChanged =
      reader !== this.activeReader ||
      tabID !== this.activeTabID ||
      !this.boundTargetsAreCurrent(reader);

    if (!targetsChanged) {
      return;
    }

    const readerChanged =
      reader !== this.activeReader || tabID !== this.activeTabID;
    this.unbindReaderTargets();
    this.activeReader = reader;
    this.activeTabID = tabID;

    if (!reader) {
      return;
    }

    this.bindReaderTargets(reader);
    if (readerChanged) {
      this.recordSignal("page-change", Date.now());
    }
  }

  private bindReaderTargets(reader: ReaderAdapter): void {
    const windows = this.getReaderWindows(reader);
    for (const frameWindow of windows) {
      this.bind(frameWindow, "wheel", this.onWheel, { passive: true });
      this.bind(frameWindow, "scroll", this.onScroll, {
        capture: true,
        passive: true,
      });
      this.bind(frameWindow, "keydown", this.onKeyDown, true);
      this.bind(frameWindow, "click", this.onContentClick, true);
      this.bind(frameWindow, "mousemove", this.onMouseMove, { passive: true });
      this.bind(frameWindow, "input", this.onInput, true);

      const document = frameWindow.document;
      this.bind(document, "selectionchange", this.onSelectionChange);
    }
  }

  private unbindReaderTargets(): void {
    for (const binding of this.boundTargets) {
      binding.target.removeEventListener(
        binding.type,
        binding.listener,
        binding.options,
      );
    }
    this.boundTargets.length = 0;
  }

  private bind(
    target: Window | Document,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, listener, options);
    this.boundTargets.push({ target, type, listener, options });
  }

  private getReaderWindows(reader: ReaderAdapter): Window[] {
    const candidates = [
      reader._iframeWindow,
      reader._internalReader?._primaryView?._iframeWindow,
      reader._internalReader?._secondaryView?._iframeWindow,
    ];
    return candidates.filter(
      (candidate, index): candidate is Window =>
        Boolean(candidate) && candidates.indexOf(candidate) === index,
    );
  }

  private boundTargetsAreCurrent(reader?: ReaderAdapter): boolean {
    if (!reader) {
      return this.boundTargets.length === 0;
    }
    const boundWindows = new Set(
      this.boundTargets
        .map((binding) => {
          const target = binding.target;
          return "defaultView" in target ? target.defaultView : target;
        })
        .filter((target): target is Window => Boolean(target)),
    );
    const currentWindows = this.getReaderWindows(reader);
    return (
      currentWindows.length > 0 &&
      currentWindows.length === boundWindows.size &&
      currentWindows.every((frameWindow) => boundWindows.has(frameWindow))
    );
  }

  private isForegroundReader(): boolean {
    const documentVisible = this.window.document.visibilityState !== "hidden";
    const appFocused =
      this.window.Services.focus.activeWindow === this.window ||
      this.window.document.hasFocus();
    const windowMinimized =
      this.window.windowState === this.window.STATE_MINIMIZED;
    const readerWindows = this.activeReader
      ? this.getReaderWindows(this.activeReader)
      : [];
    const readerReady = Boolean(
      this.activeReader &&
      readerWindows.length > 0 &&
      (this.activeReader._isReaderInitialized ||
        readerWindows.some(
          (frameWindow) => frameWindow.document.readyState !== "loading",
        )),
    );

    return calculateForegroundGate({
      appFocused,
      windowMinimized,
      documentVisible,
      activeTabType: this.window.Zotero_Tabs.selectedType,
      readerReady,
    });
  }

  private readonly onWheel: EventListener = (rawEvent): void => {
    const event = rawEvent as WheelEvent;
    this.recordSignal(event.ctrlKey || event.metaKey ? "zoom" : "scroll");
  };

  private readonly onScroll: EventListener = (): void => {
    this.recordSignal("scroll");
  };

  private readonly onKeyDown: EventListener = (rawEvent): void => {
    const event = rawEvent as KeyboardEvent;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      this.recordSignal("search");
      return;
    }
    if (NAVIGATION_KEYS.has(event.key)) {
      this.recordSignal("keyboard-navigation");
    }
  };

  private readonly onContentClick: EventListener = (): void => {
    this.recordSignal("content-click");
  };

  private readonly onMouseMove: EventListener = (): void => {
    this.recordSignal("mouse-move");
  };

  private readonly onInput: EventListener = (rawEvent): void => {
    const target = rawEvent.target as Element | null;
    if (!target || target.nodeType !== target.ELEMENT_NODE) {
      return;
    }
    const identity = `${target.id} ${target.className} ${target.getAttribute("aria-label") ?? ""}`;
    if (/find|search/i.test(identity)) {
      this.recordSignal("search");
    }
  };

  private readonly onSelectionChange: EventListener = (rawEvent): void => {
    const document = rawEvent.currentTarget as Document | null;
    if (!document || document.nodeType !== document.DOCUMENT_NODE) {
      return;
    }
    if (document.getSelection()?.toString().trim()) {
      this.recordSignal("selection");
    }
  };

  private recordSignal(type: ReadingSignal, now = Date.now()): void {
    if (!this.settings?.trackingEnabled && type !== "pet-interaction") {
      return;
    }
    const isWeak = type === "mouse-move" || type === "pet-interaction";
    const throttle = isWeak
      ? WEAK_SIGNAL_THROTTLE_MS
      : STRONG_SIGNAL_THROTTLE_MS;
    const lastAt = this.lastSignalAt.get(type) ?? Number.NEGATIVE_INFINITY;
    if (now - lastAt < throttle) {
      return;
    }
    this.lastSignalAt.set(type, now);

    const sample = isWeak ? {} : this.sampleVisibleContent(now);
    this.model.recordSignal(type, now, sample);
    this.publishSnapshot(now);
    if (type !== "mouse-move" && type !== "pet-interaction") {
      this.onSemanticEvent?.({
        type,
        observedAt: now,
        pageIndex: this.activeReader?.state?.pageIndex,
      });
    }
  }

  private publishSnapshot(observedAt: number): void {
    const trackingEnabled = this.settings?.trackingEnabled ?? true;
    this.onSnapshot({
      snapshot: this.model.tick(
        trackingEnabled && this.isForegroundReader(),
        observedAt,
      ),
      observedAt,
      item: this.getItemIdentity(),
    });
  }

  private modelOptions(): Partial<ReadingActivityModelOptions> {
    const settings = this.settings;
    return settings
      ? {
          personalWordsPerMinute: settings.personalWordsPerMinute,
          defaultExpectedSeconds: settings.defaultExpectedSeconds,
          sleepDelaySeconds: settings.sleepDelaySeconds,
        }
      : {};
  }

  private getItemIdentity(): ReaderItemIdentity | undefined {
    const attachment = this.activeReader?._item;
    if (!attachment) {
      return undefined;
    }
    const parent = attachment.parentItemID
      ? Zotero.Items.get(attachment.parentItemID)
      : false;
    const bibliographicItem = parent || attachment;
    return {
      libraryID: bibliographicItem.libraryID,
      itemKey: bibliographicItem.key,
      attachmentKey: attachment.key,
      title: String(bibliographicItem.getField("title") || ""),
    };
  }

  private sampleVisibleContent(now: number): ContentSample {
    if (now - this.lastContentSampleAt < CONTENT_SAMPLE_THROTTLE_MS) {
      return this.lastContentSample;
    }
    this.lastContentSampleAt = now;

    for (const frameWindow of this.activeReader
      ? this.getReaderWindows(this.activeReader).toReversed()
      : []) {
      const text = this.collectVisibleReaderText(frameWindow);
      const visibleWords = this.countApproximateWords(text);
      if (visibleWords > 0) {
        this.lastContentSample = { visibleWords };
        return this.lastContentSample;
      }
    }

    this.lastContentSample = {};
    return this.lastContentSample;
  }

  private collectVisibleReaderText(frameWindow: Window): string {
    const { document } = frameWindow;
    const preferred = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".textLayer, article, main, [role='document']",
      ),
    ) as HTMLElement[];
    const visible = preferred.filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= frameWindow.innerHeight &&
        rect.left <= frameWindow.innerWidth
      );
    });
    return visible
      .slice(0, 8)
      .map((element) => element.textContent ?? "")
      .join(" ");
  }

  private countApproximateWords(text: string): number {
    const latinWords =
      text.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [];
    const cjkCharacters =
      text.match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      )?.length ?? 0;
    const nonCjkWords = latinWords.filter(
      (word) =>
        !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
          word,
        ),
    ).length;
    return nonCjkWords + Math.ceil(cjkCharacters / 2);
  }
}
