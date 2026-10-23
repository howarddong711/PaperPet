import {
  calculateForegroundGate,
  type ContentSample,
  ReadingActivityModel,
  type ReadingActivityModelOptions,
  type ReadingActivitySnapshot,
  type ReadingSignal,
} from "../model/reading-activity-model";
import type { PaperPetSettings } from "../settings/paperpet-settings";
import {
  getNoteActivityTargets,
  isForegroundWindow,
  selectActiveNote,
  type NoteActivityTarget,
} from "./note-activity-context";
import { getReadingItemIdentity } from "./reading-item";
import type { ReaderItemIdentity } from "./reading-item";

export type { ReaderItemIdentity } from "./reading-item";

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
  private noteTargets: NoteActivityTarget[] = [];
  private activeNote?: NoteActivityTarget;
  private activeTabID?: string;
  private interactionWindow?: Window;
  private activeSourceKey?: string;
  private activityReady = false;
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
    this.activeNote = undefined;
    this.noteTargets = [];
    this.interactionWindow = undefined;
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
      if (
        !this.activeNote &&
        ids.some((id) => String(id) === String(this.activeReader?.itemID))
      ) {
        this.recordSignal("page-change", Date.now());
      }
      return;
    }

    if (type !== "item" || (event !== "add" && event !== "modify")) {
      return;
    }

    const attachmentID = this.activeNote
      ? undefined
      : this.activeReader?.itemID;
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

  private refreshReader(interactionWindow?: Window): void {
    const { Zotero_Tabs: tabs } = this.window;
    const tabID = tabs.selectedID;
    const reader =
      tabs.selectedType === "reader"
        ? (Zotero.Reader.getByTabID(tabID) as ReaderAdapter | undefined)
        : undefined;
    const notes = getNoteActivityTargets(this.window);
    const windows = [
      ...(reader ? this.getReaderWindows(reader) : []),
      ...notes.map((target) => target.frameWindow),
    ];
    if (
      tabID !== this.activeTabID ||
      !windows.includes(this.interactionWindow as Window)
    ) {
      this.interactionWindow = undefined;
    }
    if (interactionWindow && windows.includes(interactionWindow)) {
      this.interactionWindow = interactionWindow;
    }
    const note = selectActiveNote(
      notes,
      this.window,
      this.window.Services.focus.activeWindow,
      this.interactionWindow,
    );
    const source = note?.editor._item ?? reader?._item;
    const sourceKey = source
      ? `${source.libraryID}/${source.key || "unsaved"}`
      : undefined;
    const contextChanged =
      note?.editor !== this.activeNote?.editor ||
      (!note && reader !== this.activeReader) ||
      sourceKey !== this.activeSourceKey;
    const wasReady = this.activityReady;

    this.activeReader = reader;
    this.noteTargets = notes;
    this.activeNote = note;
    this.activeTabID = tabID;
    this.activeSourceKey = sourceKey;
    this.activityReady = Boolean(note || this.hasReadyReader());

    if (!this.boundTargetsAreCurrent(windows)) {
      this.unbindReaderTargets();
      this.bindReaderTargets(windows);
    }
    if (contextChanged) {
      this.model.resetActivity(Date.now());
      this.lastSignalAt.clear();
      this.lastContentSample = {};
      this.lastContentSampleAt = 0;
    }
    if (contextChanged || (!wasReady && this.activityReady)) {
      this.recordSignal(note ? "content-click" : "page-change");
    }
  }

  private bindReaderTargets(windows: Window[]): void {
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
      this.bind(frameWindow, "compositionend", this.onInput, true);
      this.bind(frameWindow, "message", this.onNoteMessage);
      this.bind(frameWindow, "focus", this.onContentFocus, true);

      const document = frameWindow.document;
      this.bind(document, "selectionchange", this.onSelectionChange);
    }
  }

  private unbindReaderTargets(): void {
    for (const binding of this.boundTargets) {
      try {
        binding.target.removeEventListener(
          binding.type,
          binding.listener,
          binding.options,
        );
      } catch {
        // A closed native note window can already be a dead Gecko wrapper.
      }
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

  private boundTargetsAreCurrent(currentWindows: Window[]): boolean {
    try {
      const boundWindows = new Set(
        this.boundTargets
          .map((binding) => {
            const target = binding.target;
            return "defaultView" in target ? target.defaultView : target;
          })
          .filter((target): target is Window => Boolean(target)),
      );
      return (
        currentWindows.length === boundWindows.size &&
        currentWindows.every(
          (frameWindow) =>
            boundWindows.has(frameWindow) &&
            this.boundTargets.some(
              (binding) => binding.target === frameWindow.document,
            ),
        )
      );
    } catch {
      return false;
    }
  }

  private hasReadyReader(): boolean {
    if (!this.activeReader) return false;
    const windows = this.getReaderWindows(this.activeReader);
    return (
      windows.length > 0 &&
      (this.activeReader._isReaderInitialized ||
        windows.some(
          (frameWindow) => frameWindow.document.readyState !== "loading",
        ))
    );
  }

  private isForegroundReader(): boolean {
    const host = this.activeNote?.hostWindow ?? this.window;
    return calculateForegroundGate({
      appFocused: isForegroundWindow(
        host,
        this.window.Services.focus.activeWindow,
      ),
      windowMinimized: false,
      documentVisible: host.document.visibilityState !== "hidden",
      activeTabType: this.activeNote
        ? "note"
        : this.window.Zotero_Tabs.selectedType,
      readerReady: Boolean(this.activeNote || this.hasReadyReader()),
    });
  }

  private readonly onWheel: EventListener = (rawEvent): void => {
    const event = rawEvent as WheelEvent;
    this.recordContentSignal(
      event.ctrlKey || event.metaKey ? "zoom" : "scroll",
      rawEvent,
    );
  };

  private readonly onScroll: EventListener = (event): void => {
    this.recordContentSignal("scroll", event);
  };

  private readonly onKeyDown: EventListener = (rawEvent): void => {
    const event = rawEvent as KeyboardEvent;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      this.recordContentSignal("search", rawEvent);
      return;
    }
    if (NAVIGATION_KEYS.has(event.key)) {
      this.recordContentSignal("keyboard-navigation", rawEvent);
    }
  };

  private readonly onContentClick: EventListener = (event): void => {
    this.recordContentSignal("content-click", event);
  };

  private readonly onContentFocus: EventListener = (event): void => {
    this.recordContentSignal("content-click", event);
  };

  private readonly onMouseMove: EventListener = (event): void => {
    this.recordContentSignal("mouse-move", event);
  };

  private readonly onInput: EventListener = (rawEvent): void => {
    const target = rawEvent.target as Element | null;
    if (!target || target.nodeType !== target.ELEMENT_NODE) {
      return;
    }
    const identity = `${target.id} ${target.className} ${target.getAttribute("aria-label") ?? ""}`;
    if (/find|search/i.test(identity)) {
      this.recordContentSignal("search", rawEvent);
    } else if (target.closest(".ProseMirror, [contenteditable='true']")) {
      const note = this.noteTargets.find(
        (target) =>
          target.frameWindow.document ===
          (rawEvent.target as Element).ownerDocument,
      );
      if (note && !note.editor._readOnly) {
        this.recordContentSignal("note-edit", rawEvent);
      }
    }
  };

  private readonly onNoteMessage: EventListener = (rawEvent): void => {
    const event = rawEvent as MessageEvent;
    const note = this.noteTargets.find(
      (target) => target.frameWindow === event.currentTarget,
    );
    if (
      note &&
      !note.editor._readOnly &&
      note.editor.instanceID &&
      event.source === note.frameWindow &&
      event.data?.instanceID === note.editor.instanceID &&
      event.data?.message?.action === "update" &&
      !event.data.message.system
    ) {
      // Native editor transactions also cover formatting, undo and pasted content.
      // Never read or persist noteData, and ignore automatic/system updates.
      this.recordContentSignal("note-edit", rawEvent);
    }
  };

  private readonly onSelectionChange: EventListener = (rawEvent): void => {
    const document = rawEvent.currentTarget as Document | null;
    if (!document || document.nodeType !== document.DOCUMENT_NODE) {
      return;
    }
    if (document.getSelection()?.toString().trim()) {
      this.recordContentSignal("selection", rawEvent);
    }
  };

  private recordContentSignal(type: ReadingSignal, event: Event): void {
    const target = event.currentTarget as Window | Document | null;
    const frameWindow =
      target && ("defaultView" in target ? target.defaultView : target);
    if (!frameWindow) return;
    if (type !== "mouse-move") this.refreshReader(frameWindow);
    const activeWindows = this.activeNote
      ? [this.activeNote.frameWindow]
      : this.activeReader
        ? this.getReaderWindows(this.activeReader)
        : [];
    if (activeWindows.includes(frameWindow)) this.recordSignal(type);
  }

  private recordSignal(type: ReadingSignal, now = Date.now()): void {
    if (
      type !== "pet-interaction" &&
      (!(this.settings?.trackingEnabled ?? true) || !this.isForegroundReader())
    ) {
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
    if (
      type !== "mouse-move" &&
      type !== "pet-interaction" &&
      this.getItemIdentity()
    ) {
      this.onSemanticEvent?.({
        type,
        observedAt: now,
        pageIndex: this.activeNote
          ? undefined
          : this.activeReader?.state?.pageIndex,
      });
    }
  }

  private publishSnapshot(observedAt: number): void {
    const trackingEnabled = this.settings?.trackingEnabled ?? true;
    const foreground = trackingEnabled && this.isForegroundReader();
    this.onSnapshot({
      snapshot: this.model.tick(foreground, observedAt),
      observedAt,
      item: foreground ? this.getItemIdentity() : undefined,
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
    return getReadingItemIdentity(
      this.activeNote?.editor._item ?? this.activeReader?._item,
    );
  }

  private sampleVisibleContent(now: number): ContentSample {
    if (now - this.lastContentSampleAt < CONTENT_SAMPLE_THROTTLE_MS) {
      return this.lastContentSample;
    }
    this.lastContentSampleAt = now;

    const windows = this.activeNote
      ? [this.activeNote.frameWindow]
      : this.activeReader
        ? this.getReaderWindows(this.activeReader).toReversed()
        : [];
    for (const frameWindow of windows) {
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
        this.activeNote
          ? ".ProseMirror > *"
          : ".textLayer, article, main, [role='document']",
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
