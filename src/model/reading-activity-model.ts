export type ReadingSignal =
  | "scroll"
  | "page-change"
  | "keyboard-navigation"
  | "selection"
  | "annotation"
  | "note-edit"
  | "search"
  | "zoom"
  | "content-click"
  | "mouse-move"
  | "pet-interaction";

export type ReadingMode =
  | "away"
  | "idle"
  | "reading"
  | "thinking"
  | "skimming"
  | "annotating"
  | "uncertain"
  | "sleeping";

export interface ContentSample {
  visibleWords?: number;
  contentFactor?: number;
}

export interface ForegroundGateInput {
  appFocused: boolean;
  windowMinimized: boolean;
  documentVisible: boolean;
  activeTabType: string;
  readerReady: boolean;
}

export interface ReadingActivitySnapshot {
  mode: ReadingMode;
  confidence: number;
  foregroundReaderSeconds: number;
  foregroundDeltaSeconds: number;
  effectiveReadingSeconds: number;
  effectiveDeltaSeconds: number;
  noteEditingSeconds: number;
  noteEditingDeltaSeconds: number;
  expectedReadingSeconds: number;
}

export interface ReadingActivityModelOptions {
  personalWordsPerMinute: number;
  defaultExpectedSeconds: number;
  sleepDelaySeconds: number;
  maxTickSeconds: number;
}

const DEFAULT_OPTIONS: ReadingActivityModelOptions = {
  personalWordsPerMinute: 200,
  defaultExpectedSeconds: 60,
  sleepDelaySeconds: 15,
  maxTickSeconds: 1.5,
};

const STRONG_SIGNALS = new Set<ReadingSignal>([
  "scroll",
  "page-change",
  "keyboard-navigation",
  "selection",
  "annotation",
  "note-edit",
  "search",
  "zoom",
  "content-click",
]);

const ANNOTATING_ACTION_DURATION_MS = 3_000;
export const NOTE_EDITING_IDLE_SECONDS = 15;

const NAVIGATION_SIGNALS = new Set<ReadingSignal>([
  "scroll",
  "page-change",
  "keyboard-navigation",
]);

interface RecordedSignal {
  type: ReadingSignal;
  at: number;
}

export function calculateForegroundGate(input: ForegroundGateInput): boolean {
  return (
    input.appFocused &&
    !input.windowMinimized &&
    input.documentVisible &&
    (input.activeTabType === "reader" || input.activeTabType === "note") &&
    input.readerReady
  );
}

export function calculateExpectedReadingSeconds(
  content: ContentSample,
  personalWordsPerMinute = DEFAULT_OPTIONS.personalWordsPerMinute,
  fallbackSeconds = DEFAULT_OPTIONS.defaultExpectedSeconds,
): number {
  const visibleWords = content.visibleWords;
  if (!visibleWords || visibleWords <= 0 || personalWordsPerMinute <= 0) {
    return fallbackSeconds;
  }

  const factor = content.contentFactor ?? 1;
  return clamp((60 * visibleWords * factor) / personalWordsPerMinute, 15, 600);
}

export class ReadingActivityModel {
  private options: ReadingActivityModelOptions;
  private readonly recentSignals: RecordedSignal[] = [];
  private lastTickAt?: number;
  private lastStrongAt?: number;
  private lastWeakAt?: number;
  private lastAnnotatingAt?: number;
  private gateChangedAt?: number;
  private previousGate = false;
  private expectedReadingSeconds: number;
  private foregroundReaderSeconds = 0;
  private effectiveReadingSeconds = 0;
  private noteEditingSeconds = 0;
  private readonly noteEditingWindows: { start: number; end: number }[] = [];

  public constructor(options: Partial<ReadingActivityModelOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.expectedReadingSeconds = this.options.defaultExpectedSeconds;
  }

  public updateOptions(options: Partial<ReadingActivityModelOptions>): void {
    this.options = { ...this.options, ...options };
    if (this.lastStrongAt === undefined) {
      this.expectedReadingSeconds = this.options.defaultExpectedSeconds;
    }
  }

  /** Keep totals, but do not carry a PDF/note's confidence into another item. */
  public resetActivity(now: number): void {
    this.recentSignals.length = 0;
    this.lastStrongAt = undefined;
    this.lastWeakAt = undefined;
    this.lastAnnotatingAt = undefined;
    this.noteEditingWindows.length = 0;
    this.expectedReadingSeconds = this.options.defaultExpectedSeconds;
    this.lastTickAt = now;
    this.gateChangedAt = now;
  }

  public recordSignal(
    type: ReadingSignal,
    at: number,
    content: ContentSample = {},
  ): void {
    this.pruneSignals(at);
    this.recentSignals.push({ type, at });

    if (STRONG_SIGNALS.has(type)) {
      this.lastStrongAt = at;
      this.expectedReadingSeconds = calculateExpectedReadingSeconds(
        content,
        this.options.personalWordsPerMinute,
        this.options.defaultExpectedSeconds,
      );
    } else {
      this.lastWeakAt = at;
    }

    if (type === "annotation" || type === "selection" || type === "note-edit") {
      this.lastAnnotatingAt = at;
    }
    if (type === "note-edit") {
      const end = at + NOTE_EDITING_IDLE_SECONDS * 1_000;
      const previous = this.noteEditingWindows.at(-1);
      if (previous && at <= previous.end) {
        previous.end = Math.max(previous.end, end);
      } else {
        this.noteEditingWindows.push({ start: at, end });
      }
    }
  }

  public tick(gateOpen: boolean, now: number): ReadingActivitySnapshot {
    if (this.gateChangedAt === undefined || gateOpen !== this.previousGate) {
      this.gateChangedAt = now;
      this.previousGate = gateOpen;
    }

    const elapsedSeconds =
      this.lastTickAt === undefined
        ? 0
        : clamp((now - this.lastTickAt) / 1000, 0, this.options.maxTickSeconds);
    this.lastTickAt = now;

    if (gateOpen) {
      this.foregroundReaderSeconds += elapsedSeconds;
    }

    const confidence = gateOpen ? this.calculateConfidence(now) : 0;
    const effectiveDeltaSeconds = elapsedSeconds * confidence;
    this.effectiveReadingSeconds += effectiveDeltaSeconds;

    // Only the overlap after a real edit counts, never the reading time before
    // the first input. Keep disjoint windows until sampled so a new edit cannot
    // erase the tail of a previous window between two ticks.
    const tickStart = now - elapsedSeconds * 1_000;
    const editingSeconds = gateOpen
      ? this.noteEditingWindows.reduce(
          (sum, window) =>
            sum +
            Math.max(
              0,
              Math.min(now, window.end) - Math.max(tickStart, window.start),
            ) /
              1_000,
          0,
        )
      : 0;
    const noteEditingDeltaSeconds = Math.min(
      effectiveDeltaSeconds,
      editingSeconds * confidence,
    );
    this.noteEditingSeconds += noteEditingDeltaSeconds;
    if (!gateOpen) {
      // Returning to the editor must require a new edit, not resume old input.
      this.noteEditingWindows.length = 0;
    } else {
      while (this.noteEditingWindows[0]?.end <= now) {
        this.noteEditingWindows.shift();
      }
    }

    return {
      mode: this.calculateMode(gateOpen, confidence, now),
      confidence,
      foregroundReaderSeconds: this.foregroundReaderSeconds,
      foregroundDeltaSeconds: gateOpen ? elapsedSeconds : 0,
      effectiveReadingSeconds: this.effectiveReadingSeconds,
      effectiveDeltaSeconds,
      noteEditingSeconds: this.noteEditingSeconds,
      noteEditingDeltaSeconds,
      expectedReadingSeconds: this.expectedReadingSeconds,
    };
  }

  private calculateConfidence(now: number): number {
    if (this.lastStrongAt === undefined) {
      return 0;
    }

    const ageSeconds = Math.max(0, (now - this.lastStrongAt) / 1000);
    const expected = this.expectedReadingSeconds;
    const hardStop = clamp(expected * 2, 45, 900);
    const highConfidenceWindow = Math.min(8, expected * 0.25);

    let confidence: number;
    if (ageSeconds <= highConfidenceWindow) {
      confidence = 1;
    } else if (ageSeconds <= expected) {
      const progress =
        (ageSeconds - highConfidenceWindow) /
        Math.max(1, expected - highConfidenceWindow);
      confidence = 1 - progress * 0.25;
    } else if (ageSeconds < hardStop) {
      const progress = (ageSeconds - expected) / (hardStop - expected);
      confidence = 0.75 * (1 - smoothStep(progress));
    } else {
      confidence = 0;
    }

    const weakSignalIsRecent =
      this.lastWeakAt !== undefined && now - this.lastWeakAt <= 5000;
    if (confidence > 0 && weakSignalIsRecent) {
      confidence = Math.min(1, confidence + 0.05);
    }

    return clamp(confidence, 0, 1);
  }

  private calculateMode(
    gateOpen: boolean,
    confidence: number,
    now: number,
  ): ReadingMode {
    const gateAge = Math.max(0, (now - (this.gateChangedAt ?? now)) / 1000);
    if (!gateOpen) {
      return gateAge >= this.options.sleepDelaySeconds ? "sleeping" : "away";
    }

    if (
      this.lastAnnotatingAt !== undefined &&
      now - this.lastAnnotatingAt <= ANNOTATING_ACTION_DURATION_MS
    ) {
      return "annotating";
    }

    if (confidence <= 0) {
      if (this.lastWeakAt !== undefined && now - this.lastWeakAt <= 4000) {
        return "uncertain";
      }
      return gateAge >= this.options.sleepDelaySeconds ? "sleeping" : "idle";
    }

    this.pruneSignals(now);
    const recentNavigationCount = this.recentSignals.filter(
      (signal) =>
        NAVIGATION_SIGNALS.has(signal.type) && now - signal.at <= 5000,
    ).length;
    if (recentNavigationCount >= 4) {
      return "skimming";
    }

    const strongAgeSeconds =
      this.lastStrongAt === undefined ? 0 : (now - this.lastStrongAt) / 1000;
    if (strongAgeSeconds >= Math.min(20, this.expectedReadingSeconds * 0.65)) {
      return "thinking";
    }

    return "reading";
  }

  private pruneSignals(now: number): void {
    while (
      this.recentSignals.length > 0 &&
      now - this.recentSignals[0].at > 10_000
    ) {
      this.recentSignals.shift();
    }
  }
}

function smoothStep(value: number): number {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
