-- Rename project_relative to workspace_relative to describe the path's actual base.
-- The workspace root holds .kozane/ and is shared by all its namespaces.
-- resolveTaskspacePath joins the stored path to workspaceRoot without consulting a
-- namespace. A nullable taskspace.namespace_id also lets unplaced taskspaces use this
-- path kind, including records reattached from markers with no namespace.
--
-- Rebuild taskspace to change the column default as well as existing values. SQLite
-- cannot alter the default in place. The migrator does not enforce foreign keys during
-- this rebuild, so dropping the old table preserves card.taskspace_id references.
-- This behavior was checked through the migrator. Running the rebuild through
-- client.batch instead triggers the ON DELETE set null action and clears those links.
CREATE TABLE `__new_taskspace` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_id` text,
	`scope_id` text,
	`name` text DEFAULT '' NOT NULL,
	`path` text,
	`path_kind` text DEFAULT 'workspace_relative' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespace`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`scope_id`) REFERENCES `scope`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_taskspace` SELECT `id`, `namespace_id`, `scope_id`, `name`, `path`, CASE `path_kind` WHEN 'project_relative' THEN 'workspace_relative' ELSE `path_kind` END, `last_seen_at`, `created_at`, `updated_at` FROM `taskspace`;--> statement-breakpoint
DROP TABLE `taskspace`;--> statement-breakpoint
ALTER TABLE `__new_taskspace` RENAME TO `taskspace`;--> statement-breakpoint
CREATE INDEX `taskspace_scope` ON `taskspace` (`scope_id`);
