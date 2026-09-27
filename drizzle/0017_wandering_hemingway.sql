DROP INDEX `scope_area_scope_namespace`;--> statement-breakpoint
CREATE INDEX `scope_area_scope` ON `scope_area` (`scope_id`,`namespace_id`);