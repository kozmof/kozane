CREATE TABLE `local_file_operation` (
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
	CONSTRAINT "local_file_operation_kind" CHECK("local_file_operation"."kind" = 'taskspace.claim' AND "local_file_operation"."version" = 1),
	CONSTRAINT "local_file_operation_path_kind" CHECK("local_file_operation"."path_kind" IN ('workspace_relative', 'absolute')),
	CONSTRAINT "local_file_operation_state" CHECK(("local_file_operation"."state" = 'pending' AND "local_file_operation"."confirmed_at" IS NULL) OR ("local_file_operation"."state" = 'confirmed' AND "local_file_operation"."confirmed_at" IS NOT NULL AND "local_file_operation"."error" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `local_file_operation_state` ON `local_file_operation` (`state`);