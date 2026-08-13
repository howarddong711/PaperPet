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
});

describe("calculateExpectedReadingSeconds", () => {
  it("uses visible words and clamps extreme pages", () => {
    expect(calculateExpectedReadingSeconds({ visibleWords: 200 }, 200)).toBe(
      60,
    );
    expect(calculateExpectedReadingSeconds({ visibleWords: 5 }, 200)).toBe(15);
    expect(calculateExpectedReadingSeconds({ visibleWords: 2000 }, 200)).toBe(
      120,
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
