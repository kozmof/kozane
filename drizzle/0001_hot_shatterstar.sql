CREATE UNIQUE INDEX `bundle_name_per_project` ON `bundle` (`project_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `scope_name_unique` ON `scope` (`name`);