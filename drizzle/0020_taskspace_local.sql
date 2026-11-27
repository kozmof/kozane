-- Keep local attachments independently of shared taskspace identity. Do not add a foreign
-- key: shared deletion and restoration must retain metadata for temporarily absent rows.
CREATE TABLE `taskspace_local` (
  `taskspace_id` text PRIMARY KEY NOT NULL,
  `path` text,
  `path_kind` text DEFAULT 'workspace_relative' NOT NULL,
  `last_seen_at` integer
);
--> statement-breakpoint
INSERT INTO `taskspace_local` (`taskspace_id`, `path`, `path_kind`, `last_seen_at`)
SELECT `id`, `path`, `path_kind`, `last_seen_at` FROM `taskspace`;
--> statement-breakpoint
-- Dropping these columns preserves the taskspace table, its IDs, timestamps and card FKs.
ALTER TABLE `taskspace` DROP COLUMN `path`;
--> statement-breakpoint
ALTER TABLE `taskspace` DROP COLUMN `path_kind`;
--> statement-breakpoint
ALTER TABLE `taskspace` DROP COLUMN `last_seen_at`;
