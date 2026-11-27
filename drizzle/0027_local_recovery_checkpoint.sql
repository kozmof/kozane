CREATE TABLE `local_recovery_checkpoint` (
	`workspace_id` text NOT NULL,
	`device_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`descriptor` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `device_id`, `epoch_id`, `checkpoint_id`),
	CONSTRAINT "local_recovery_checkpoint_identity" CHECK(length(trim("local_recovery_checkpoint"."workspace_id")) BETWEEN 1 AND 1000 AND instr("local_recovery_checkpoint"."workspace_id",char(0))=0 AND length(trim("local_recovery_checkpoint"."device_id")) BETWEEN 1 AND 1000 AND instr("local_recovery_checkpoint"."device_id",char(0))=0 AND length(trim("local_recovery_checkpoint"."epoch_id")) BETWEEN 1 AND 1000 AND instr("local_recovery_checkpoint"."epoch_id",char(0))=0 AND length(trim("local_recovery_checkpoint"."checkpoint_id")) BETWEEN 1 AND 1000 AND instr("local_recovery_checkpoint"."checkpoint_id",char(0))=0),
	CONSTRAINT "local_recovery_checkpoint_descriptor" CHECK(json_valid("local_recovery_checkpoint"."descriptor") AND json_type("local_recovery_checkpoint"."descriptor",'$.version') IS 'integer' AND json_extract("local_recovery_checkpoint"."descriptor",'$.version') IS 1 AND json_extract("local_recovery_checkpoint"."descriptor",'$.identity.workspaceId') IS "local_recovery_checkpoint"."workspace_id" AND json_extract("local_recovery_checkpoint"."descriptor",'$.identity.deviceId') IS "local_recovery_checkpoint"."device_id" AND json_extract("local_recovery_checkpoint"."descriptor",'$.identity.epochId') IS "local_recovery_checkpoint"."epoch_id" AND json_extract("local_recovery_checkpoint"."descriptor",'$.identity.checkpointId') IS "local_recovery_checkpoint"."checkpoint_id")
);
