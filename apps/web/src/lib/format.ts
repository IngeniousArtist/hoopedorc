import type { ProjectSchedule } from "@orc/types";

/**
 * Headline USD formatting (U8): 4-decimal precision is right for a
 * $0.0034 per-task/per-run figure, but makes headline totals ("$0.0000
 * spent") look broken rather than precise. Use this only for
 * headline/aggregate figures; per-task and per-run rows should keep their
 * own 4-decimal formatting.
 */
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

/** U7: short chip label for a project's auto-start schedule, or null when
 *  there's nothing configured (or it's disabled) to show. */
export function formatSchedule(schedule?: ProjectSchedule): string | null {
  if (!schedule?.enabled) return null;
  if (schedule.mode === "interval" && schedule.intervalHours) {
    return `⏱ every ${schedule.intervalHours}h`;
  }
  if (schedule.mode === "daily" && schedule.hour != null && schedule.minute != null) {
    const hh = String(schedule.hour).padStart(2, "0");
    const mm = String(schedule.minute).padStart(2, "0");
    return `⏱ daily ${hh}:${mm}`;
  }
  return null;
}
