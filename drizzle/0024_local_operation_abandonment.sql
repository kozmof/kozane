CREATE TABLE `__new_local_file_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`taskspace_id` text NOT NULL,
	`namespace_id` text NOT NULL,
	`path` text NOT NULL,
	`path_kind` text NOT NULL,
	`state` text NOT NULL,
	`intent` text NOT NULL,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`error` text,
	`abandoned_at` integer,
	`abandon_reason` text,
	CONSTRAINT "local_file_operation_kind" CHECK("__new_local_file_operation"."kind" IN ('taskspace.claim', 'taskspace.file', 'taskspace.directory') AND "__new_local_file_operation"."version" = 1),
	CONSTRAINT "local_file_operation_path_kind" CHECK("__new_local_file_operation"."path_kind" IN ('workspace_relative', 'absolute')),
	CONSTRAINT "local_file_operation_state" CHECK(("__new_local_file_operation"."state" = 'pending' AND "__new_local_file_operation"."confirmed_at" IS NULL AND "__new_local_file_operation"."abandoned_at" IS NULL AND "__new_local_file_operation"."abandon_reason" IS NULL) OR ("__new_local_file_operation"."state" = 'confirmed' AND "__new_local_file_operation"."confirmed_at" IS NOT NULL AND "__new_local_file_operation"."error" IS NULL AND "__new_local_file_operation"."abandoned_at" IS NULL AND "__new_local_file_operation"."abandon_reason" IS NULL) OR ("__new_local_file_operation"."state" = 'abandoned' AND "__new_local_file_operation"."confirmed_at" IS NULL AND "__new_local_file_operation"."abandoned_at" IS NOT NULL AND "__new_local_file_operation"."abandon_reason" IS NOT NULL AND length(trim("__new_local_file_operation"."abandon_reason")) > 0))
);
--> statement-breakpoint
INSERT INTO `__new_local_file_operation`("id", "kind", "version", "taskspace_id", "namespace_id", "path", "path_kind", "state", "intent", "created_at", "confirmed_at", "error", "abandoned_at", "abandon_reason") SELECT "id", "kind", "version", "taskspace_id", "namespace_id", "path", "path_kind", "state", "intent", "created_at", "confirmed_at", "error", NULL, NULL FROM `local_file_operation`;--> statement-breakpoint
DROP TABLE `local_file_operation`;--> statement-breakpoint
ALTER TABLE `__new_local_file_operation` RENAME TO `local_file_operation`;--> statement-breakpoint
CREATE INDEX `local_file_operation_state` ON `local_file_operation` (`state`);