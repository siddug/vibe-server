CREATE TABLE `execution_processes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`prompt` text NOT NULL,
	`exit_code` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exec_proc_session_idx` ON `execution_processes` (`session_id`);--> statement-breakpoint
CREATE INDEX `exec_proc_status_idx` ON `execution_processes` (`status`);--> statement-breakpoint
CREATE TABLE `process_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`process_id` text NOT NULL,
	`log_type` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `execution_processes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proc_logs_process_idx` ON `process_logs` (`process_id`);--> statement-breakpoint
CREATE INDEX `proc_logs_timestamp_idx` ON `process_logs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_type` text NOT NULL,
	`work_dir` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);