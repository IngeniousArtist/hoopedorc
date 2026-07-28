import type { Project, ProjectSchedule, ServerEvent } from "@orc/types";

/** How long past the scheduled HH:MM a daily run may still fire. */
export const DAILY_GRACE_MS = 5 * 60 * 1000;

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

  // mode === "daily": fire once within a short grace window after HH:MM,
  // server-local time, and not again until a different calendar day has
  // started. The window (rather than an exact-minute equality check)
  // matters because the caller polls with setInterval(~60s), which drifts
  // forward a few ms per tick — an exact-minute check gets skipped entirely
  // whenever one tick lands at :59.9xx and the next lands just past the
  // following minute, silently losing that day's run. The window is kept
  // short deliberately: a server that was DOWN at the scheduled time does
  // NOT retroactively fire on boot hours later (cron semantics, not
  // anacron) — auto-starting a paid model run at an unexpected time is
  // worse than skipping a maintenance night.
  if (schedule.hour == null || schedule.minute == null) return false;
  const scheduledToday = new Date(now);
  scheduledToday.setHours(schedule.hour, schedule.minute, 0, 0);
  const sinceScheduledMs = now.getTime() - scheduledToday.getTime();
  if (sinceScheduledMs < 0 || sinceScheduledMs >= DAILY_GRACE_MS) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  const firedToday =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();
  return !firedToday;
}

export interface ScheduleTickDependencies {
  getProjects(): Project[];
  startProject(projectId: string): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  updateProject(
    projectId: string,
    patch: { status: "running"; lastScheduledRunAt: string },
  ): Project | null | undefined;
  broadcast(event: ServerEvent): void;
  runBackground(label: string, operation: () => Promise<void>): void;
  logInfo(message: string): void;
  now?(): Date;
}

/**
 * Find due projects synchronously, then hand each start to the server's
 * shutdown-tracked background owner. Keeping the async operation inside that
 * owner is what makes start, persistence, and broadcast failures observable
 * without turning a routine schedule tick into an unhandled rejection.
 */
export function checkSchedules(deps: ScheduleTickDependencies): void {
  const now = deps.now ?? (() => new Date());
  const checkedAt = now();
  for (const project of deps.getProjects()) {
    const schedule = project.config?.schedule;
    if (!schedule || !isScheduleDue(schedule, project.lastScheduledRunAt, checkedAt)) {
      continue;
    }
    const label =
      `scheduled ${schedule.mode} start for "${project.name}" (${project.id})`;
    deps.runBackground(label, async () => {
      const result = await deps.startProject(project.id);
      if (!result.ok) {
        deps.logInfo(`scheduled start skipped for "${project.name}": ${result.error}`);
        return;
      }
      const updated = deps.updateProject(project.id, {
        status: "running",
        lastScheduledRunAt: now().toISOString(),
      });
      if (updated) {
        deps.broadcast({ type: "project.updated", payload: updated });
      }
      deps.logInfo(`scheduled start: ${project.name}`);
    });
  }
}
