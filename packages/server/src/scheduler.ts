import type { ProjectSchedule } from "@orc/types";

/**
 * F19: pure due-check, kept separate from the `setInterval` wiring in
 * `index.ts` so the date math is testable without booting a server. `now`
 * defaults to the real clock; tests pass a fixed `Date` instead.
 */
export function isScheduleDue(
  schedule: ProjectSchedule | undefined,
  lastRunAt: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!schedule?.enabled) return false;

  if (schedule.mode === "interval") {
    if (!schedule.intervalHours || schedule.intervalHours <= 0) return false;
    if (!lastRunAt) return true; // never auto-started — due immediately
    const elapsedMs = now.getTime() - new Date(lastRunAt).getTime();
    return elapsedMs >= schedule.intervalHours * 60 * 60 * 1000;
  }

  // mode === "daily": fire once during the exact HH:MM minute, server-local
  // time, and not again until a different calendar day has started.
  if (schedule.hour == null || schedule.minute == null) return false;
  if (now.getHours() !== schedule.hour || now.getMinutes() !== schedule.minute) {
    return false;
  }
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  const firedToday =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  return !firedToday;
}
