CREATE TABLE `scope_area` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`namespace_id` text NOT NULL,
	`pos_x` integer DEFAULT 0 NOT NULL,
	`pos_y` integer DEFAULT 0 NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `scope`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`namespace_id`) REFERENCES `namespace`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scope_area_scope_namespace` ON `scope_area` (`scope_id`,`namespace_id`);--> statement-breakpoint
CREATE INDEX `scope_area_namespace` ON `scope_area` (`namespace_id`);