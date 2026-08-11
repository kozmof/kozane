CREATE TABLE `warp` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`pos_x` integer DEFAULT 0 NOT NULL,
	`pos_y` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE cascade ON DELETE cascade
);
