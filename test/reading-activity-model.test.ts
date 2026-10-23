import { describe, expect, it } from "vitest";
import {
  calculateExpectedReadingSeconds,
  calculateForegroundGate,
  ReadingActivityModel,
} from "../src/model/reading-activity-model";

describe("calculateForegroundGate", () => {
  const activeReader = {
    appFocused: true,
    windowMinimized: false,
    documentVisible: true,
    activeTabType: "reader",
    readerReady: true,
  };

  it("opens only for a visible, focused, ready reader", () => {
    expect(calculateForegroundGate(activeReader)).toBe(true);

    for (const override of [
      { appFocused: false },
      { windowMinimized: true },
      { documentVisible: false },
      { activeTabType: "library" },
      { readerReady: false },
    ]) {
      expect(calculateForegroundGate({ ...activeReader, ...override })).toBe(
        false,
      );
    }
  });

  it("accepts a resolved note editor, but never a bare library or report", () => {
    expect(
      calculateForegroundGate({ ...activeReader, activeTabType: "note" }),
    ).toBe(true);
    expect(
      calculateForegroundGate({
        ...activeReader,
        activeTabType: "note",
        readerReady: false,
      }),
    ).toBe(false);
    expect(
      calculateForegroundGate({
        ...activeReader,
        activeTabType: "paperpet-dashboard",
      }),
    ).toBe(false);
  });
});

describe("calculateExpectedReadingSeconds", () => {
  it("uses visible words and clamps extreme pages", () => {
    expect(calculateExpectedReadingSeconds({ visibleWords: 200 }, 200)).toBe(
      60,
    );
    expect(calculateExpectedReadingSeconds({ visibleWords: 5 }, 200)).toBe(15);
    expect(calculateExpectedReadingSeconds({ visibleWords: 2000 }, 200)).toBe(
      600,
    );
  });

  it("uses the fallback for scanned or empty pages", () => {
    expect(calculateExpectedReadingSeconds({}, 200, 52)).toBe(52);
    expect(calculateExpectedReadingSeconds({ visibleWords: 0 }, 200, 52)).toBe(
      52,
    );
  });
});

describe("ReadingActivityModel", () => {
  it("immediately stops accumulating when the foreground gate closes", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("scroll", 0, { visibleWords: 200 });
    model.tick(true, 0);
    const active = model.tick(true, 1000);
    const background = model.tick(false, 2000);

    expect(active.effectiveDeltaSeconds).toBe(1);
    expect(active.foregroundDeltaSeconds).toBe(1);
    expect(background.effectiveDeltaSeconds).toBe(0);
    expect(background.foregroundDeltaSeconds).toBe(0);
    expect(background.effectiveReadingSeconds).toBe(
      active.effectiveReadingSeconds,
    );
    expect(background.mode).toBe("away");
  });

  it("does not let weak signals create reading time", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("mouse-move", 0);
    model.tick(true, 0);
    const snapshot = model.tick(true, 1000);

    expect(snapshot.confidence).toBe(0);
    expect(snapshot.effectiveReadingSeconds).toBe(0);
    expect(snapshot.mode).toBe("uncertain");
  });

  it("decays smoothly and hard-stops according to visible content", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("content-click", 0, { visibleWords: 200 });
    model.tick(true, 0);

    const reading = model.tick(true, 8000);
    const thinking = model.tick(true, 40_000);
    const stopped = model.tick(true, 120_000);

    expect(reading.confidence).toBe(1);
    expect(thinking.confidence).toBeGreaterThan(0);
    expect(thinking.confidence).toBeLessThan(1);
    expect(thinking.mode).toBe("thinking");
    expect(stopped.confidence).toBe(0);
    expect(stopped.effectiveDeltaSeconds).toBe(0);
  });

  it("distinguishes annotating and rapid skimming", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("annotation", 0);
    model.tick(true, 0);
    expect(model.tick(true, 1000).mode).toBe("annotating");

    const skimmer = new ReadingActivityModel();
    skimmer.recordSignal("scroll", 0);
    skimmer.recordSignal("page-change", 1000);
    skimmer.recordSignal("scroll", 2000);
    skimmer.recordSignal("keyboard-navigation", 3000);
    skimmer.tick(true, 3000);
    expect(skimmer.tick(true, 3500).mode).toBe("skimming");
  });

  it("shows the annotating action as soon as text is selected", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("selection", 0, { visibleWords: 200 });
    model.tick(true, 0);

    expect(model.tick(true, 1_000).mode).toBe("annotating");
    expect(model.tick(true, 3_000).mode).toBe("annotating");
    expect(model.tick(true, 3_001).mode).not.toBe("annotating");
  });

  it("treats note edits as strong annotating activity and stops on focus loss", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    expect(model.tick(true, 1_000)).toMatchObject({
      mode: "annotating",
      confidence: 1,
      effectiveDeltaSeconds: 1,
    });
    expect(model.tick(false, 2_000)).toMatchObject({
      mode: "away",
      effectiveDeltaSeconds: 0,
      foregroundDeltaSeconds: 0,
    });
  });

  it("does not carry confidence or annotating state between a paper and a note", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("annotation", 0);
    model.tick(true, 0);
    const previous = model.tick(true, 1_000);
    model.resetActivity(1_000);
    const next = model.tick(true, 2_000);
    expect(next.mode).not.toBe("annotating");
    expect(next.confidence).toBe(0);
    expect(next.effectiveReadingSeconds).toBe(previous.effectiveReadingSeconds);
  });

  it("never labels reading, selecting or annotating a PDF as note editing", () => {
    const model = new ReadingActivityModel();
    model.tick(true, 0);
    for (const [index, type] of (
      ["content-click", "scroll", "selection", "annotation", "search"] as const
    ).entries()) {
      const now = (index + 1) * 1_000;
      model.recordSignal(type, now);
      expect(model.tick(true, now).noteEditingDeltaSeconds).toBe(0);
    }
    const snapshot = model.tick(true, 6_000);
    expect(snapshot.effectiveReadingSeconds).toBeGreaterThan(0);
    expect(snapshot.noteEditingSeconds).toBe(0);
  });

  it("starts editing at actual input without backdating the previous reading tick", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("content-click", 0);
    model.tick(true, 0);
    model.tick(true, 1_000);
    model.recordSignal("note-edit", 1_750);
    expect(model.tick(true, 1_750).noteEditingSeconds).toBe(0);
    const next = model.tick(true, 2_000);
    expect(next.noteEditingDeltaSeconds).toBe(0.25);
    expect(next.noteEditingSeconds).toBe(0.25);
    expect(next.noteEditingSeconds).toBeLessThan(next.effectiveReadingSeconds);
  });

  it("extends continuous editing without multiplying time by input count", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    for (let now = 250; now <= 30_000; now += 250) {
      model.recordSignal("note-edit", now);
      const snapshot = model.tick(true, now);
      expect(snapshot.noteEditingDeltaSeconds).toBe(0.25);
      expect(snapshot.noteEditingDeltaSeconds).toBeLessThanOrEqual(
        snapshot.effectiveDeltaSeconds,
      );
    }
    expect(model.tick(true, 30_000).noteEditingSeconds).toBe(30);
  });

  it("clips the final idle tick to 15 seconds and stops until another edit", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    model.tick(true, 14_500);
    const last = model.tick(true, 15_500);
    expect(last.noteEditingDeltaSeconds).toBeCloseTo(0.5 * last.confidence);
    model.recordSignal("scroll", 16_000);
    const reading = model.tick(true, 16_000);
    expect(reading.effectiveDeltaSeconds).toBeGreaterThan(0);
    expect(reading.noteEditingDeltaSeconds).toBe(0);
    expect(reading.noteEditingSeconds).toBe(last.noteEditingSeconds);
  });

  it("preserves the previous editing tail when an expired window is renewed between ticks", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    model.tick(true, 14_800);
    model.recordSignal("note-edit", 15_300);
    expect(model.tick(true, 15_300).noteEditingDeltaSeconds).toBeCloseTo(0.2);
    expect(model.tick(true, 15_800).noteEditingDeltaSeconds).toBe(0.5);
  });

  it("pauses on focus loss and requires a fresh edit after returning", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    const active = model.tick(true, 1_000);
    expect(model.tick(false, 2_000).noteEditingDeltaSeconds).toBe(0);
    const returned = model.tick(true, 3_000);
    expect(returned.noteEditingDeltaSeconds).toBe(0);
    expect(returned.noteEditingSeconds).toBe(active.noteEditingSeconds);
    model.recordSignal("note-edit", 3_500);
    expect(model.tick(true, 3_500).noteEditingDeltaSeconds).toBe(0);
    expect(model.tick(true, 4_000).noteEditingDeltaSeconds).toBe(0.5);
  });

  it("keeps editing totals but clears the editing window on a source switch", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    model.tick(true, 1_000);
    model.resetActivity(1_000);
    model.recordSignal("page-change", 1_000);
    const pdf = model.tick(true, 2_000);
    expect(pdf.effectiveDeltaSeconds).toBe(1);
    expect(pdf.noteEditingDeltaSeconds).toBe(0);
    expect(pdf.noteEditingSeconds).toBe(1);
  });

  it("never backfills a suspended timer as editing time", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("note-edit", 0);
    model.tick(true, 0);
    expect(model.tick(true, 60_000).noteEditingDeltaSeconds).toBe(0);
    model.recordSignal("note-edit", 60_000);
    const resumed = model.tick(true, 64_000);
    expect(resumed.noteEditingDeltaSeconds).toBe(1.5);
    expect(resumed.noteEditingDeltaSeconds).toBeLessThanOrEqual(
      resumed.effectiveDeltaSeconds,
    );
  });

  it("moves from away to sleeping without adding time", () => {
    const model = new ReadingActivityModel({ sleepDelaySeconds: 15 });
    model.tick(false, 0);
    expect(model.tick(false, 14_000).mode).toBe("away");
    const sleeping = model.tick(false, 15_000);
    expect(sleeping.mode).toBe("sleeping");
    expect(sleeping.effectiveReadingSeconds).toBe(0);
  });

  it("applies updated reading preferences without replacing the model", () => {
    const model = new ReadingActivityModel({ sleepDelaySeconds: 60 });
    model.tick(false, 0);
    expect(model.tick(false, 10_000).mode).toBe("away");

    model.updateOptions({ sleepDelaySeconds: 5 });
    expect(model.tick(false, 11_000).mode).toBe("sleeping");
  });

  it("keeps a long sampling run bounded and inexpensive", () => {
    const model = new ReadingActivityModel();
    model.recordSignal("scroll", 0, { visibleWords: 240 });
    model.tick(true, 0);
    const started = performance.now();
    for (let index = 1; index <= 100_000; index += 1) {
      if (index % 250 === 0) {
        model.recordSignal("scroll", index * 1_000, { visibleWords: 240 });
      }
      model.tick(true, index * 1_000);
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_500);
    expect(
      model.tick(true, 100_001 * 1_000).effectiveReadingSeconds,
    ).toBeGreaterThan(0);
  });
});
