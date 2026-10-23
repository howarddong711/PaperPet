import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReaderActivityController,
  type ReadingActivityUpdate,
  type SemanticReadingEvent,
} from "../src/tracking/reader-activity-controller";
import { DEFAULT_PAPERPET_SETTINGS } from "../src/settings/paperpet-settings";

class Surface {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string, detail: Record<string, unknown> = {}): void {
    const event = {
      type,
      currentTarget: this,
      target: this,
      ...detail,
    } as unknown as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event);
  }
  get listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (sum, listeners) => sum + listeners.size,
      0,
    );
  }
}

class TestDocument extends Surface {
  visibilityState = "visible";
  readyState = "complete";
  focused = false;
  editorReady = true;
  nodeType = 9;
  DOCUMENT_NODE = 9;
  readonly elements = new Map<string, unknown>();
  constructor(readonly defaultView: TestWindow) {
    super();
  }
  hasFocus(): boolean {
    return this.focused;
  }
  getElementById(id: string): unknown {
    return this.elements.get(id) ?? null;
  }
  querySelector(): unknown {
    return this.editorReady ? this.content : null;
  }
  querySelectorAll(): unknown[] {
    return [this.content];
  }
  getSelection(): { toString: () => string } {
    return { toString: () => "selected note text" };
  }
  readonly content = {
    textContent: "visible text ".repeat(100),
    getBoundingClientRect: () => ({
      width: 600,
      height: 400,
      top: 0,
      left: 0,
      bottom: 400,
      right: 600,
    }),
  };
}

class TestWindow extends Surface {
  readonly document = new TestDocument(this);
  closed = false;
  windowState = 0;
  STATE_MINIMIZED = 1;
  innerWidth = 800;
  innerHeight = 600;
  frameElement?: {
    ownerDocument: TestDocument;
    isConnected: boolean;
    getBoundingClientRect: () => { width: number; height: number };
  };
  getComputedStyle(): { display: string; visibility: string } {
    return { display: "block", visibility: "visible" };
  }
}

function item(
  id: number,
  key: string,
  type: "note" | "attachment" | "paper",
  parentItemID?: number,
) {
  return {
    id,
    key,
    libraryID: 1,
    parentItemID,
    isNote: () => type === "note",
    isAnnotation: () => false,
    getField: () => (type === "note" ? "" : `${type} title`),
    getNoteTitle: () => "Independent note title",
  };
}

function environment() {
  const main = Object.assign(new TestWindow(), {
    Zotero_Tabs: { selectedType: "library", selectedID: "library" },
    ZoteroContextPane: { collapsed: true, activeEditor: undefined as unknown },
    Services: { focus: { activeWindow: undefined as unknown } },
    setInterval: (handler: () => void, delay: number) =>
      globalThis.setInterval(handler, delay),
    clearInterval: (id: ReturnType<typeof globalThis.setInterval>) =>
      globalThis.clearInterval(id),
  });
  main.document.focused = true;
  main.Services.focus.activeWindow = main;
  const paper = item(1, "PAPER", "paper");
  const pdf = item(2, "PDF", "attachment", paper.id);
  const note = item(3, "NOTE", "note", paper.id);
  const items = new Map([
    [paper.id, paper],
    [pdf.id, pdf],
    [note.id, note],
  ]);
  const registry: ReturnType<typeof makeNote>[] = [];
  let tabNote: ReturnType<typeof makeNote> | undefined;
  const mainWindows: unknown[] = [main];
  const observers: {
    notify: (event: string, type: string, ids: number[]) => void;
  }[] = [];
  const pdfFrame = frame(main);
  const reader = {
    itemID: pdf.id,
    _item: pdf,
    _iframeWindow: pdfFrame,
    _internalReader: {},
    _isReaderInitialized: true,
    state: { pageIndex: 4 },
  };
  vi.stubGlobal("Zotero", {
    getMainWindows: () => mainWindows,
    Notes: { _editorInstances: registry, getByTabID: () => tabNote ?? null },
    Reader: { getByTabID: () => reader },
    Items: { get: (id: number) => items.get(id) ?? false },
    Notifier: {
      registerObserver: (observer: (typeof observers)[number]) => {
        observers.push(observer);
        return "observer";
      },
      unregisterObserver: vi.fn(),
    },
  });
  function frame(host: TestWindow): TestWindow {
    const target = new TestWindow();
    target.frameElement = {
      ownerDocument: host.document,
      isConnected: true,
      getBoundingClientRect: () => ({ width: 600, height: 400 }),
    };
    return target;
  }
  function makeNote(source = note, host: TestWindow = main, mode = "library") {
    return {
      _item: source,
      _iframeWindow: frame(host),
      _viewMode: mode,
      _readOnly: false,
      instanceID: `note-${source.id}`,
    };
  }
  function libraryNote(editor = makeNote()) {
    main.Zotero_Tabs.selectedType = "library";
    main.Zotero_Tabs.selectedID = "library";
    main.document.elements.set("zotero-item-pane", { mode: "note" });
    main.document.elements.set("zotero-note-editor", {
      getCurrentInstance: () => editor,
    });
    return editor;
  }
  function noteTab(editor = makeNote(note, main, "tab")) {
    tabNote = editor;
    main.Zotero_Tabs.selectedType = "note";
    main.Zotero_Tabs.selectedID = "note-tab";
    return editor;
  }
  function readerTab() {
    main.Zotero_Tabs.selectedType = "reader";
    main.Zotero_Tabs.selectedID = "pdf-tab";
  }
  const updates: ReadingActivityUpdate[] = [];
  const events: SemanticReadingEvent[] = [];
  const controller = new ReaderActivityController(
    main as unknown as _ZoteroTypes.MainWindow,
    (update) => updates.push(update),
    (event) => events.push(event),
    { ...DEFAULT_PAPERPET_SETTINGS },
  );
  function edit(editor: ReturnType<typeof makeNote>, type = "input") {
    const target = {
      nodeType: 1,
      ELEMENT_NODE: 1,
      id: "",
      className: "ProseMirror",
      ownerDocument: editor._iframeWindow.document,
      getAttribute: () => null,
      closest: () => target,
    };
    editor._iframeWindow.fire(type, { target });
  }
  function noteMessage(editor: ReturnType<typeof makeNote>, system: boolean) {
    editor._iframeWindow.fire("message", {
      source: editor._iframeWindow,
      data: {
        instanceID: editor.instanceID,
        message: { action: "update", system },
      },
    });
  }
  return {
    main,
    mainWindows,
    paper,
    pdf,
    note,
    items,
    registry,
    observers,
    reader,
    pdfFrame,
    frame,
    makeNote,
    libraryNote,
    noteTab,
    readerTab,
    controller,
    updates,
    events,
    edit,
    noteMessage,
    latest: () => updates.at(-1)!,
  };
}

describe("native note activity integration", () => {
  let env: ReturnType<typeof environment>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T04:00:00Z"));
    env = environment();
  });
  afterEach(() => {
    env.controller.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("counts reading a library note under its paper, not the previously opened PDF", () => {
    env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest()).toMatchObject({
      item: { itemKey: "PAPER", attachmentKey: "NOTE", title: "paper title" },
      snapshot: {
        mode: "reading",
        foregroundDeltaSeconds: 1,
        effectiveDeltaSeconds: 1,
        noteEditingSeconds: 0,
        noteEditingDeltaSeconds: 0,
      },
    });
  });

  it("recognizes typing and Chinese composition without creating PDF annotations", () => {
    const editor = env.libraryNote();
    env.controller.start();
    for (let index = 0; index < 20; index += 1) {
      vi.advanceTimersByTime(2_000);
      env.edit(editor, index % 2 ? "compositionend" : "input");
      expect(env.latest().snapshot.mode).toBe("annotating");
    }
    expect(env.events.some((event) => event.type === "note-edit")).toBe(true);
    expect(env.events.some((event) => event.type === "annotation")).toBe(false);
    expect(env.latest().snapshot.effectiveReadingSeconds).toBeGreaterThan(35);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(38);
    expect(JSON.stringify(env.events)).not.toContain("visible text");
  });

  it("resolves an independent note's own title in a native note tab", () => {
    env.noteTab(env.makeNote(item(4, "INDEPENDENT", "note"), env.main, "tab"));
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().item).toMatchObject({
      itemKey: "INDEPENDENT",
      attachmentKey: "INDEPENDENT",
      title: "Independent note title",
    });
    expect(env.latest().snapshot.mode).toBe("reading");
  });

  it("switches between a PDF and its sidebar note without double-counting time", () => {
    env.readerTab();
    const editor = env.makeNote(env.note, env.main, "context");
    env.main.ZoteroContextPane.collapsed = false;
    env.main.ZoteroContextPane.activeEditor = {
      getCurrentInstance: () => editor,
    };
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().item?.attachmentKey).toBe("PDF");
    editor._iframeWindow.fire("wheel");
    vi.advanceTimersByTime(1_000);
    expect(env.latest().item?.attachmentKey).toBe("NOTE");
    const count = env.events.length;
    env.observers[0].notify("pageChange", "file", [env.pdf.id]);
    expect(env.events).toHaveLength(count);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(0);
    expect(env.events.at(-1)?.pageIndex).toBeUndefined();
    env.pdfFrame.fire("click");
    vi.advanceTimersByTime(1_000);
    expect(env.latest().item?.attachmentKey).toBe("PDF");
    expect(env.latest().snapshot.effectiveReadingSeconds).toBe(3);
  });

  it("detects user editor transactions but ignores automatic saves and foreign messages", () => {
    const editor = env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    const count = env.events.length;
    env.noteMessage(editor, true);
    editor._iframeWindow.fire("message", {
      source: env.pdfFrame,
      data: {
        instanceID: editor.instanceID,
        message: { action: "update", system: false },
      },
    });
    expect(env.events).toHaveLength(count);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(0);
    env.noteMessage(editor, false);
    expect(env.events.at(-1)?.type).toBe("note-edit");
    expect(env.latest().snapshot.mode).toBe("annotating");
  });

  it("does not let automatic saves renew an editing interval", () => {
    const editor = env.libraryNote();
    env.controller.start();
    env.edit(editor);
    vi.advanceTimersByTime(15_000);
    const editing = env.latest().snapshot.noteEditingSeconds;
    for (let index = 0; index < 10; index += 1) {
      env.noteMessage(editor, true);
      vi.advanceTimersByTime(1_000);
    }
    expect(env.latest().snapshot.noteEditingSeconds).toBe(editing);
    expect(env.latest().snapshot.noteEditingDeltaSeconds).toBe(0);
  });

  it("counts editing separately, stops after inactivity, and does not resume merely on focus", () => {
    const editor = env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(0);
    env.edit(editor);
    expect(env.latest().snapshot.noteEditingDeltaSeconds).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(2);
    env.main.document.focused = false;
    env.main.Services.focus.activeWindow = null;
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(2);
    env.main.document.focused = true;
    env.main.Services.focus.activeWindow = env.main;
    editor._iframeWindow.fire("focus");
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(2);
    env.edit(editor, "compositionend");
    vi.advanceTimersByTime(16_000);
    const stopped = env.latest().snapshot.noteEditingSeconds;
    expect(stopped).toBeGreaterThan(15);
    expect(stopped).toBeLessThanOrEqual(17);
    vi.advanceTimersByTime(3_000);
    expect(env.latest().snapshot.noteEditingSeconds).toBe(stopped);
    expect(env.latest().snapshot.noteEditingDeltaSeconds).toBe(0);
  });

  it("stops counting and emitting note events outside the foreground app", () => {
    const editor = env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    const total = env.latest().snapshot.effectiveReadingSeconds;
    env.main.Services.focus.activeWindow = null;
    env.main.document.focused = false;
    vi.advanceTimersByTime(5_000);
    const count = env.events.length;
    env.edit(editor);
    env.noteMessage(editor, false);
    expect(env.events).toHaveLength(count);
    expect(env.latest().item).toBeUndefined();
    expect(env.latest().snapshot).toMatchObject({
      mode: "away",
      effectiveReadingSeconds: total,
      foregroundDeltaSeconds: 0,
    });
  });

  it("does not count a hidden note while viewing a report or another library item", () => {
    env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    env.main.Zotero_Tabs.selectedType = "paperpet-dashboard";
    env.main.Zotero_Tabs.selectedID = "report";
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(0);
    expect(env.latest().item).toBeUndefined();
    env.main.Zotero_Tabs.selectedType = "library";
    env.main.Zotero_Tabs.selectedID = "library";
    env.main.document.elements.set("zotero-item-pane", { mode: "item" });
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(0);
  });

  it("tracks a focused detached note, but not a minimized or closed window", () => {
    const host = new TestWindow();
    const editor = env.makeNote(env.note, host, "window");
    env.registry.push(editor);
    env.main.document.focused = false;
    host.document.focused = true;
    env.main.Services.focus.activeWindow = host;
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().item?.attachmentKey).toBe("NOTE");
    expect(env.latest().snapshot.mode).toBe("reading");
    host.windowState = host.STATE_MINIMIZED;
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(0);
    host.closed = true;
    vi.advanceTimersByTime(1_000);
    expect(editor._iframeWindow.listenerCount).toBe(0);
    expect(env.latest().item).toBeUndefined();
  });

  it("does not track detached notes a second time from another main window", () => {
    const otherMain = new TestWindow();
    env.mainWindows.unshift(otherMain);
    const host = new TestWindow();
    env.registry.push(env.makeNote(env.note, host, "window"));
    env.main.document.focused = false;
    env.main.Services.focus.activeWindow = host;
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveReadingSeconds).toBe(0);
    expect(env.latest().item).toBeUndefined();
  });

  it("rebinds a replaced note frame and removes listeners at shutdown", () => {
    const oldEditor = env.libraryNote();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    const newEditor = env.libraryNote(env.makeNote(item(5, "NEWNOTE", "note")));
    vi.advanceTimersByTime(1_000);
    expect(oldEditor._iframeWindow.listenerCount).toBe(0);
    expect(oldEditor._iframeWindow.document.listenerCount).toBe(0);
    env.edit(oldEditor);
    expect(env.latest().item?.itemKey).toBe("NEWNOTE");
    env.controller.destroy();
    expect(newEditor._iframeWindow.listenerCount).toBe(0);
    expect(newEditor._iframeWindow.document.listenerCount).toBe(0);
  });

  it("waits for a delayed editor and accepts read-only note reading", () => {
    const editor = env.libraryNote();
    editor._readOnly = true;
    editor._iframeWindow.document.editorReady = false;
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(0);
    editor._iframeWindow.document.editorReady = true;
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.mode).toBe("reading");
    env.edit(editor);
    expect(env.events.some((event) => event.type === "note-edit")).toBe(false);
  });

  it("respects disabled tracking for both note input and transactions", () => {
    const editor = env.libraryNote();
    env.controller.updateSettings({
      ...DEFAULT_PAPERPET_SETTINGS,
      trackingEnabled: false,
    });
    env.controller.start();
    env.edit(editor);
    env.noteMessage(editor, false);
    vi.advanceTimersByTime(2_000);
    expect(env.latest().snapshot.effectiveReadingSeconds).toBe(0);
    expect(env.events).toHaveLength(0);
  });

  it("ignores collapsed sidebar editors and detached frames with no visible area", () => {
    env.readerTab();
    const editor = env.makeNote(env.note, env.main, "context");
    env.main.ZoteroContextPane.activeEditor = {
      getCurrentInstance: () => editor,
    };
    env.controller.start();
    expect(editor._iframeWindow.listenerCount).toBe(0);
    env.main.ZoteroContextPane.collapsed = false;
    editor._iframeWindow.frameElement!.getBoundingClientRect = () => ({
      width: 0,
      height: 0,
    });
    vi.advanceTimersByTime(1_000);
    expect(editor._iframeWindow.listenerCount).toBe(0);
    expect(env.latest().item?.attachmentKey).toBe("PDF");
  });

  it("does not assign an unsaved note to the last paper, and starts once it has a key", () => {
    env.readerTab();
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    const previousEvents = env.events.length;
    const editor = env.libraryNote(env.makeNote(item(5, "", "note")));
    vi.advanceTimersByTime(1_000);
    env.edit(editor);
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.mode).toBe("annotating");
    expect(env.latest().item).toBeUndefined();
    expect(env.events).toHaveLength(previousEvents);
    editor._item.key = "SAVED";
    vi.advanceTimersByTime(2_000);
    expect(env.latest().item).toMatchObject({
      itemKey: "SAVED",
      attachmentKey: "SAVED",
    });
  });

  it("seeds reading after a delayed PDF initializes with an inactive note sidebar", () => {
    env.readerTab();
    env.reader._isReaderInitialized = false;
    env.pdfFrame.document.readyState = "loading";
    const editor = env.makeNote(env.note, env.main, "context");
    env.main.ZoteroContextPane.collapsed = false;
    env.main.ZoteroContextPane.activeEditor = {
      getCurrentInstance: () => editor,
    };
    env.controller.start();
    vi.advanceTimersByTime(1_000);
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(0);
    env.pdfFrame.document.readyState = "complete";
    vi.advanceTimersByTime(2_000);
    expect(env.latest().item?.attachmentKey).toBe("PDF");
    expect(env.latest().snapshot.mode).toBe("reading");
    expect(env.latest().snapshot.effectiveDeltaSeconds).toBe(1);
  });
});
