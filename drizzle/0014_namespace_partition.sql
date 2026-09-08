-- Hand-written rather than taken from `drizzle-kit generate`.
--
-- drizzle-kit renders a SQLite rename as a table rebuild: create `__new_card`, copy, `DROP
-- TABLE card`, rename into place. Migration 0005 could afford that because the table it
-- rebuilt was reachable from nothing; `card` is not. `glue_rel` and `scope_rel` both point at
-- it with `ON DELETE cascade`, and the `PRAGMA foreign_keys=off` that 0005 relies on is set
-- outside the migrator's transaction and does not hold inside it — so the rebuild would take
-- every group and every scope membership in the workspace with it.
--
-- `ALTER TABLE ... RENAME` needs none of that. SQLite rewrites the `REFERENCES` clauses of
-- every other table, and the column lists of every index, as part of the rename itself, and
-- it does so whether or not the `foreign_keys` pragma is on. The rows are never copied.
--
-- What SQLite will not do is rename an index. An index keeps its own name across a table or
-- column rename even as its definition is rewritten, and SQLite has no `ALTER INDEX`, so the
-- eight indexes that carry `project` or `bundle` in their names are dropped and recreated at
-- the end. That is a rebuild of the index, not of the table.
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
