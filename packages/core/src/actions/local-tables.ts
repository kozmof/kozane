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
  "local_recovery_actions",
  "local_recovery_retained_history",
  "local_recovery_retained_assets",
  "local_recovery_action_archives",
  "local_recovery_run_archives",
  "local_recovery_run_assets",
]);

/** Destination authority cannot be transported or become shared application data. */
export const recoveryDestinationTableNames: readonly string[] = Object.freeze([
  "local_recovery_installation",
  "shared_recovery_installation",
  "shared_only_recovery_installation",
]);
