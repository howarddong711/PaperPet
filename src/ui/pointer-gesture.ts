export function hasCrossedDragThreshold(
  deltaX: number,
  deltaY: number,
  threshold: number,
): boolean {
  return Math.hypot(deltaX, deltaY) >= threshold;
}
