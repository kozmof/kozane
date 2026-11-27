CREATE TABLE `local_recovery_installation` (
	`id` integer PRIMARY KEY NOT NULL,
	`descriptor` text NOT NULL,
	`installed_at` integer NOT NULL,
	CONSTRAINT "local_recovery_installation_singleton" CHECK("local_recovery_installation"."id" IS 1),
	CONSTRAINT "local_recovery_installation_time" CHECK(typeof("local_recovery_installation"."installed_at")='integer' AND "local_recovery_installation"."installed_at">=0),
	CONSTRAINT "local_recovery_installation_descriptor" CHECK(json_valid("local_recovery_installation"."descriptor") AND json_type("local_recovery_installation"."descriptor",'$.version') IS 'integer' AND json_extract("local_recovery_installation"."descriptor",'$.version') IS 1 AND json_type("local_recovery_installation"."descriptor",'$.runAssetCheckpoint.version') IS 'integer' AND json_extract("local_recovery_installation"."descriptor",'$.runAssetCheckpoint.version') IS 1 AND json_type("local_recovery_installation"."descriptor",'$.byteLength') IS 'integer' AND json_extract("local_recovery_installation"."descriptor",'$.byteLength') BETWEEN 1 AND 9007199254740991 AND json_type("local_recovery_installation"."descriptor",'$.sha256') IS 'text' AND length(json_extract("local_recovery_installation"."descriptor",'$.sha256')) IS 64 AND json_extract("local_recovery_installation"."descriptor",'$.sha256') NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TRIGGER local_recovery_installation_no_update BEFORE UPDATE ON local_recovery_installation BEGIN SELECT RAISE(ABORT,'Local recovery installation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER local_recovery_installation_no_delete BEFORE DELETE ON local_recovery_installation BEGIN SELECT RAISE(ABORT,'Local recovery installation is immutable'); END;
