export type TaskChangeWaitResult = "change" | "deadline";

interface Waiter {
  afterVersion: number;
  settle: (result: TaskChangeWaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ProjectChangeState {
  version: number;
  waiters: Set<Waiter>;
}

/**
 * Same-process wakeup hint for durable task generations.
 *
 * Correctness never depends on this bus: the SQLite generation and scheduler
 * deadline recover missed/out-of-process signals. The monotonically increasing
 * memory version closes notify-before-wait races without a lossy boolean flag.
 */
export class TaskChangeBus {
  private readonly projects = new Map<string, ProjectChangeState>();

  currentVersion(projectId: string): number {
    return this.projects.get(projectId)?.version ?? 0;
  }

  notify(projectId: string): number {
    const state = this.state(projectId);
    state.version++;
    for (const waiter of [...state.waiters]) {
      if (state.version > waiter.afterVersion) {
        waiter.settle("change");
      }
    }
    return state.version;
  }

  waitForChange(
    projectId: string,
    afterVersion: number,
    deadlineMs: number,
  ): Promise<TaskChangeWaitResult> {
    const state = this.state(projectId);
    if (state.version > afterVersion) {
      return Promise.resolve("change");
    }

    return new Promise((resolve) => {
      let settled = false;
      const waiter = {
        afterVersion,
        settle: (result: TaskChangeWaitResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(waiter.timer);
          state.waiters.delete(waiter);
          resolve(result);
        },
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      waiter.timer = setTimeout(() => waiter.settle("deadline"), deadlineMs);
      state.waiters.add(waiter);

      // Recheck after registration. JavaScript callbacks do not normally
      // interleave this synchronous block, but keeping the invariant local
      // makes the primitive safe if its storage/notification boundary evolves.
      if (state.version > afterVersion) {
        waiter.settle("change");
      }
    });
  }

  private state(projectId: string): ProjectChangeState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = { version: 0, waiters: new Set() };
      this.projects.set(projectId, state);
    }
    return state;
  }
}
