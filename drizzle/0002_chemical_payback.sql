CREATE TABLE `project_scope_rel` (
	`project_id` text NOT NULL,
	`scope_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `scope_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`scope_id`) REFERENCES `scope`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `project_scope_rel` (`project_id`, `scope_id`)
SELECT DISTINCT `project_id`, `scope_id` FROM `working_copy` WHERE `scope_id` IS NOT NULL;
