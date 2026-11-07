/** The last request queued for each taskspace. See {@link oneAtATime}. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Run `work` after every earlier change to the same taskspace has finished: renaming or
 * deleting the taskspace, or creating, saving, renaming, or deleting one of its files.
 *
 * A taskspace rename moves its directory, so a file change running at the same time could
 * resolve the old directory and fail, and two renames could both start from the old path
 * and leave the name and the directory out of step. Resolve the taskspace's directory
 * inside `work`, so it sees the path any earlier rename left. This covers requests to this
 * server only, not the CLI.
 */
export async function oneAtATime<T>(taskspaceId: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(taskspaceId) ?? Promise.resolve();
  const run = before.then(work);
  const tail = run.catch(() => undefined);
  queues.set(taskspaceId, tail);
  try {
    return await run;
  } finally {
    if (queues.get(taskspaceId) === tail) queues.delete(taskspaceId);
  }
}
