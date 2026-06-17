CREATE TABLE `bundle` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bundle_one_default_per_project` ON `bundle` (`project_id`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `card` (
	`id` text PRIMARY KEY NOT NULL,
	`bundle_id` text NOT NULL,
	`working_copy_id` text,
	`content` text NOT NULL,
	`pos_x` integer DEFAULT 0 NOT NULL,
	`pos_y` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bundle_id`) REFERENCES `bundle`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`working_copy_id`) REFERENCES `working_copy`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `glue_rel` (
	`glue_id` text NOT NULL,
	`card_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`glue_id`) REFERENCES `glue`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `glue` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scope_rel` (
	`scope_id` text NOT NULL,
	`card_id` text NOT NULL,
	PRIMARY KEY(`scope_id`, `card_id`),
	FOREIGN KEY (`scope_id`) REFERENCES `scope`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scope` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT "scope_name_nonempty" CHECK(length("scope"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE `working_copy` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`scope_id` text,
	`name` text DEFAULT '' NOT NULL,
	`path` text,
	`path_kind` text DEFAULT 'project_relative' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`scope_id`) REFERENCES `scope`(`id`) ON UPDATE cascade ON DELETE set null
);
