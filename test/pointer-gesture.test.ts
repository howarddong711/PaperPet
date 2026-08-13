import { describe, expect, it } from "vitest";
import { hasCrossedDragThreshold } from "../src/ui/pointer-gesture";

describe("hasCrossedDragThreshold", () => {
  it("uses the actual pointer travel distance", () => {
    expect(hasCrossedDragThreshold(3, 4, 5)).toBe(true);
    expect(hasCrossedDragThreshold(2, 2, 5)).toBe(false);
  });

  it("works in every direction and includes the boundary", () => {
    expect(hasCrossedDragThreshold(-6, 0, 6)).toBe(true);
    expect(hasCrossedDragThreshold(0, -6, 6)).toBe(true);
    expect(hasCrossedDragThreshold(-4, -4, 6)).toBe(false);
  });
});
