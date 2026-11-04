/** Common quota windows. Epoch reset timestamps are seconds; snapshots are ISO strings. */
export interface UsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt: number;
  resetAtIso: string;
  resetIn: string;
}

export function usageWindow(usedPercent: number, resetsAt: number, nowMs: number, windowMinutes?: number): UsageWindow {
  const minutes = Math.floor((resetsAt * 1000 - nowMs) / 60000);
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    resetAtIso: new Date(resetsAt * 1000).toISOString(),
    resetIn: minutes <= 0 ? 'reset' : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`,
  };
}
