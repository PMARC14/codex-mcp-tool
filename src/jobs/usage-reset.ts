/** Parse absolute, relative, or local-clock resets from CLI quota messages. */
export function usageReset(message: string, now = new Date()): number | undefined {
  const iso = /reset(?:s|ting)?(?:\s+at|\s+on|:)?\s*"?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(message);
  if (iso) {
    const timestamp = Date.parse(iso[1]);
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  const delay = /retry[_ ]?(?:delay|after)"?[:\s]+"?(\d+(?:\.\d+)?)\s*s/i.exec(message);
  if (delay) return now.getTime() + Number(delay[1]) * 1000;
  const relative = /\b(?:in|after)\s+(?=\d)(?:(\d+)\s*(?:hours?|h)\s*)?(?:(\d+)\s*(?:minutes?|min|m)\s*)?(?:(\d+)\s*(?:seconds?|sec|s))?\b/i.exec(message);
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const seconds = Number(relative[1] ?? 0) * 3600 + Number(relative[2] ?? 0) * 60 + Number(relative[3] ?? 0);
    if (seconds > 0) return now.getTime() + seconds * 1000;
  }
  const time = /try again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(message);
  if (!time) return undefined;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const reset = new Date(now);
  reset.setHours((hour % 12) + (time[3].toUpperCase() === 'PM' ? 12 : 0), minute, 0, 0);
  const elapsed = now.getTime() - reset.getTime();
  // Minute-precision messages can arrive just after reset. Retry soon instead of waiting a day;
  // if quota is still exhausted, the next attempt will persist a fresh limit message.
  if (elapsed >= 0 && elapsed < 2 * 60 * 60 * 1000) return now.getTime() + 60000;
  if (elapsed >= 0) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

/** Model-specific messages pause only that model; unspecified limits pause the connector. */
export function usageLimit(message: string, now = new Date()): { resetAt?: number; model?: string } {
  return {
    resetAt: usageReset(message, now),
    model: /\bmodel\s+["']?([a-z0-9][a-z0-9._-]*)/i.exec(message)?.[1],
  };
}
