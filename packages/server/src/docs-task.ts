import type { Task } from "@orc/types";

/**
 * Add a standing docs task unless one already exists (avoid duplicates).
 * The appended task depends on EVERY other task in the batch, so it always
 * dispatches last and documents the finished project.
 *
 * A planner-authored docs task gets the same treatment: the planner is told
 * not to create one, but when it does anyway it tends to give it few or no
 * dependencies — the exact bug this exists to prevent (a docs task running
 * concurrently with the scaffold, failing gates against a half-built repo).
 * Every docs-role task in the batch has its deps extended to cover all
 * non-docs tasks; user edits in the Plan review table happen after this.
 *
 * `dependsOn` values are indices into the same (draft) array — see
 * `DraftTask` in @orc/types.
 */
export function ensureDocsTask<
  T extends { role?: Task["role"]; dependsOn: number[] },
>(tasks: T[], docsTask: T): T[] {
  if (tasks.some((t) => t.role === "docs")) {
    return tasks.map((t, self) =>
      t.role === "docs"
        ? {
            ...t,
            dependsOn: tasks.flatMap((other, i) =>
              i !== self && other.role !== "docs" ? [i] : [],
            ),
          }
        : t,
    );
  }
  return [...tasks, { ...docsTask, dependsOn: tasks.map((_, i) => i) }];
}
