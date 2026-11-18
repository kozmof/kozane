/** Device-local rows never belong to a shared projection or effect set. */
export const localTableNames: readonly string[] = Object.freeze([
  "taskspace_local",
  "local_file_operation",
  "local_image_upload",
  "local_asset_manifest",
  "local_recovery_checkpoint",
  "local_recovery_shared_history",
  "local_recovery_assets",
  "local_recovery_executions",
]);
