/** Device-local rows never belong to a shared projection or effect set. */
export const localTableNames: readonly string[] = Object.freeze([
  "taskspace_local",
  "local_file_operation",
]);
