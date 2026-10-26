export function visibleChipCount(
  chipWidths: number[],
  gap: number,
  plusWidth: number,
  maxWidth: number,
): number {
  if (chipWidths.length === 0) return 0;
  if (chipWidths.length === 1 || maxWidth <= 0) return 1;
  let used = 0;
  let visible = 0;
  for (let i = 0; i < chipWidths.length; i++) {
    const next = used + (visible > 0 ? gap : 0) + chipWidths[i];
    const leftover = chipWidths.length - (visible + 1);
    const plus = leftover > 0 ? gap + plusWidth : 0;
    if (next + plus > maxWidth + 0.5) {
      return Math.max(1, visible);
    }
    used = next;
    visible += 1;
  }
  return visible;
}

/** Round fractional DPR measurements so chips never paint past the host. */
export function visibleChipCountFromRects(
  chipWidths: number[],
  gap: number,
  plusWidth: number,
  hostWidth: number,
): number {
  return visibleChipCount(
    chipWidths.map((width) => Math.ceil(width)),
    gap,
    Math.ceil(plusWidth),
    Math.max(0, Math.floor(hostWidth)),
  );
}
