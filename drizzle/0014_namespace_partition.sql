-- Use explicit renames to preserve rows and their references.
--
-- drizzle-kit generates a table rebuild for this rename. Dropping card during a rebuild
-- could cascade to glue_rel and scope_rel and remove their memberships. The foreign-key
-- pragma used by migration 0005 does not protect this rebuild inside the migrator's
-- transaction.
--
-- ALTER TABLE ... RENAME updates other tables' REFERENCES clauses and index column lists
-- without copying rows. This works with foreign-key enforcement enabled or disabled.
--
-- Index names survive table and column renames. SQLite has no ALTER INDEX, so recreate
-- the eight indexes whose names contain project or bundle after renaming the tables.
ALTER TABLE `project` RENAME TO `namespace`;--> statement-breakpoint
ALTER TABLE `bundle` RENAME TO `partition`;--> statement-breakpoint
ALTER TABLE `partition` RENAME COLUMN `project_id` TO `namespace_id`;--> statement-breakpoint
ALTER TABLE `layer` RENAME COLUMN `project_id` TO `namespace_id`;--> statement-breakpoint
ALTER TABLE `warp` RENAME COLUMN `project_id` TO `namespace_id`;--> statement-breakpoint
ALTER TABLE `taskspace` RENAME COLUMN `project_id` TO `namespace_id`;--> statement-breakpoint
ALTER TABLE `card` RENAME COLUMN `bundle_id` TO `partition_id`;--> statement-breakpoint
DROP INDEX `project_one_default`;--> statement-breakpoint
CREATE UNIQUE INDEX `namespace_one_default` ON `namespace` (`is_default`) WHERE is_default = 1;--> statement-breakpoint
DROP INDEX `bundle_one_default_per_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `partition_one_default_per_namespace` ON `partition` (`namespace_id`) WHERE is_default = 1;--> statement-breakpoint
DROP INDEX `bundle_name_per_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `partition_name_per_namespace` ON `partition` (`namespace_id`,`name`);--> statement-breakpoint
DROP INDEX `layer_one_default_per_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `layer_one_default_per_namespace` ON `layer` (`namespace_id`) WHERE is_default = 1;--> statement-breakpoint
DROP INDEX `layer_name_per_project`;--> statement-breakpoint
CREATE UNIQUE INDEX `layer_name_per_namespace` ON `layer` (`namespace_id`,`name`);--> statement-breakpoint
DROP INDEX `warp_project`;--> statement-breakpoint
CREATE INDEX `warp_namespace` ON `warp` (`namespace_id`);--> statement-breakpoint
DROP INDEX `card_bundle`;--> statement-breakpoint
CREATE INDEX `card_partition` ON `card` (`partition_id`);--> statement-breakpoint
DROP INDEX `card_bundle_updated`;--> statement-breakpoint
CREATE INDEX `card_partition_updated` ON `card` (`partition_id`,`updated_at`);
