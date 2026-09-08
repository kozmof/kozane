-- `project_relative` never meant the entity renamed in 0014. It means "relative to the
-- workspace root" — the directory holding `.kozane/`, one per workspace and shared by every
-- namespace in it. `resolveTaskspacePath` takes a `workspaceRoot` and joins the stored path
-- onto it; no namespace is passed in or consulted. And `taskspace.namespace_id` is nullable,
-- so a row can carry this value while belonging to no namespace at all — which is what a
-- `taskspace scan --apply --reattach` from a marker naming no namespace produces.
--
-- A rebuild rather than an UPDATE, because the value is also the column's DEFAULT and SQLite
-- cannot alter one in place. Dropping `taskspace` is safe here for the reason migration 0005
-- already relies on when it rebuilds `card`: the migrator does not enforce foreign keys, so
-- the `ON DELETE set null` on `card.taskspace_id` does not fire and no card loses its
-- taskspace. Checked against the driver through the migrator itself rather than assumed —
-- the same rebuild run through `client.batch` *does* cascade, which is what makes this worth
-- writing down.
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
