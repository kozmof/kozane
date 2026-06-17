PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scope` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT "scope_name_nonempty" CHECK(length("__new_scope"."name") > 0)
);
--> statement-breakpoint
INSERT INTO `__new_scope`("id", "name") SELECT "id", "name" FROM `scope`;--> statement-breakpoint
DROP TABLE `scope`;--> statement-breakpoint
ALTER TABLE `__new_scope` RENAME TO `scope`;--> statement-breakpoint
PRAGMA foreign_keys=ON;