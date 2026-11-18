/** Undo schema 20 only when building historical migration fixtures. */
export const UNDO_TASKSPACE_LOCAL_SQL = [
  "DROP TABLE local_recovery_executions",
  "DROP TABLE local_recovery_assets",
  "DROP TABLE local_recovery_shared_history",
  "DROP TABLE local_recovery_checkpoint",
  "DROP TABLE local_asset_manifest",
  "DROP TABLE local_image_upload",
  "DROP TABLE local_file_operation",
  "ALTER TABLE taskspace ADD COLUMN path text",
  "ALTER TABLE taskspace ADD COLUMN path_kind text DEFAULT 'workspace_relative' NOT NULL",
  "ALTER TABLE taskspace ADD COLUMN last_seen_at integer",
  "UPDATE taskspace SET path=(SELECT path FROM taskspace_local WHERE taskspace_id=taskspace.id),path_kind=coalesce((SELECT path_kind FROM taskspace_local WHERE taskspace_id=taskspace.id),'workspace_relative'),last_seen_at=(SELECT last_seen_at FROM taskspace_local WHERE taskspace_id=taskspace.id)",
  "DROP TABLE taskspace_local",
] as const;
