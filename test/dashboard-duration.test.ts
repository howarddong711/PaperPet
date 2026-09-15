import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/dashboard/dashboard-view";

describe("dashboard durations", () => {
  it("distinguishes zero and short readings without rounding up", () => {
    expect(formatDuration(0, "zh-CN")).toBe("0 秒");
    expect(formatDuration(23, "zh-CN")).toBe("23 秒");
    expect(formatDuration(59.9, "en-US")).toBe("59 sec");
    expect(formatDuration(60, "zh-CN")).toBe("1 分钟");
    expect(formatDuration(3599, "en-US")).toBe("59 min");
    expect(formatDuration(3660, "zh-CN")).toBe("1 小时 1 分");
  });

  it("handles invalid and negative durations", () => {
    expect(formatDuration(-1, "en-US")).toBe("0 sec");
    expect(formatDuration(Number.NaN, "en-US")).toBe("0 sec");
  });
});
