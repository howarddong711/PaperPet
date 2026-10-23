/** Native Zotero note editors, including read-only notes and detached windows. */
export interface NoteEditorAdapter {
  _item?: Zotero.Item;
  _iframeWindow?: Window;
  _viewMode?: string;
  _readOnly?: boolean;
  instanceID?: string;
}

interface NoteEditorElement extends Element {
  getCurrentInstance?: () => NoteEditorAdapter | undefined;
}

export interface NoteActivityTarget {
  editor: NoteEditorAdapter;
  frameWindow: Window;
  hostWindow: Window;
  primary: boolean;
}

export function getNoteActivityTargets(
  window: _ZoteroTypes.MainWindow,
): NoteActivityTarget[] {
  const targets: NoteActivityTarget[] = [];
  const add = (
    editor: NoteEditorAdapter | undefined,
    primary: boolean,
  ): void => {
    try {
      const frameWindow = editor?._iframeWindow;
      if (!editor || !frameWindow || frameWindow.closed || !editor._item)
        return;
      const frame =
        frameWindow.frameElement ??
        frameWindow.browsingContext?.embedderElement;
      const hostWindow = frame?.ownerDocument?.defaultView;
      if (!frame?.isConnected || !hostWindow || hostWindow.closed) return;
      if (editor._viewMode !== "window" && hostWindow !== window) return;
      const rect = frame.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const style = hostWindow.getComputedStyle(frame);
      if (style?.display === "none" || style?.visibility === "hidden") return;
      // The iframe can exist before the editor has received its initial data.
      if (!frameWindow.document.querySelector(".ProseMirror")) return;
      if (targets.some((target) => target.frameWindow === frameWindow)) return;
      targets.push({ editor, frameWindow, hostWindow, primary });
    } catch {
      // Zotero can destroy an editor between enumeration and the next tick.
    }
  };
  const fromElement = (element: Element | null | undefined) =>
    (element as NoteEditorElement | undefined)?.getCurrentInstance?.();

  const tabs = window.Zotero_Tabs;
  if (tabs.selectedType === "note") {
    add(Zotero.Notes.getByTabID(tabs.selectedID) ?? undefined, true);
  } else if (tabs.selectedType === "library") {
    const itemPane = window.document.getElementById("zotero-item-pane") as
      (Element & { mode?: string }) | null;
    if (itemPane?.mode === "note") {
      add(
        fromElement(window.document.getElementById("zotero-note-editor")),
        true,
      );
    }
  }

  if (tabs.selectedType === "reader" || tabs.selectedType === "note") {
    // Zotero's type declarations describe an EditorInstance here, but Zotero 10
    // actually returns the <note-editor> element (contextPane.js).
    const pane = window.ZoteroContextPane as unknown as {
      collapsed?: boolean;
      activeEditor?: Element;
    };
    if (pane && !pane.collapsed) add(fromElement(pane.activeEditor), false);
  }

  // One main-window controller owns detached editors. Otherwise every Zotero
  // main window would count the same detached note and split each other's session.
  if (Zotero.getMainWindows()[0] === window) {
    for (const editor of Zotero.Notes._editorInstances ?? []) {
      if (editor._viewMode === "window") add(editor, true);
    }
  }
  return targets;
}

export function isForegroundWindow(
  window: Window,
  activeWindow: unknown,
): boolean {
  try {
    const host = window as Window & {
      windowState?: number;
      STATE_MINIMIZED?: number;
    };
    return (
      !host.closed &&
      host.document.visibilityState !== "hidden" &&
      (host.windowState === undefined ||
        host.windowState !== host.STATE_MINIMIZED) &&
      (activeWindow === host || host.document.hasFocus())
    );
  } catch {
    return false;
  }
}

export function selectActiveNote(
  targets: NoteActivityTarget[],
  mainWindow: Window,
  activeWindow: unknown,
  interactionWindow?: Window,
): NoteActivityTarget | undefined {
  const detached = targets.find(
    (target) =>
      target.hostWindow !== mainWindow &&
      isForegroundWindow(target.hostWindow, activeWindow),
  );
  if (detached) return detached;

  const local = targets.filter((target) => target.hostWindow === mainWindow);
  // An explicit PDF interaction takes precedence over a still-visible sidebar.
  if (interactionWindow) {
    const interactedNote = local.find(
      (target) => target.frameWindow === interactionWindow,
    );
    return interactedNote ?? local.find((target) => target.primary);
  }
  return (
    local.find((target) => target.frameWindow.document.hasFocus()) ??
    local.find((target) => target.primary)
  );
}
