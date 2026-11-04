/** Parse a local clock reset from a quota message shared by CLI connectors. */
export function usageReset(message: string, now = new Date()): number | undefined {
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
