/** Serialize writes for one project, including cleanup flushes across remounts.
 * Rejections reach the caller but cannot poison subsequent recovery operations. */
const tails = new Map<string, Promise<void>>();

export function queuePlanningWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(projectId) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => {}, () => {});
  tails.set(projectId, tail);
  void tail.then(() => {
    if (tails.get(projectId) === tail) tails.delete(projectId);
  });
  return result;
}

/** Reads wait for already scheduled writes, but never block subsequent reads. */
export function afterPlanningWrites<T>(projectId: string, read: () => Promise<T>): Promise<T> {
  return (tails.get(projectId) ?? Promise.resolve()).then(read);
}
