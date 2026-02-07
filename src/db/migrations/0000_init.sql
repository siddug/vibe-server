-- Complete database schema for vibe-server
-- All tables, indexes, and constraints in a single migration

CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_type` text NOT NULL,
	`work_dir` text NOT NULL,
	`session_name` text,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`approval_mode` text DEFAULT 'manual' NOT NULL,
	`agent_mode` text DEFAULT 'default' NOT NULL,
	`agent_session_id` text,
	`scheduled_task_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `sessions_scheduled_task_idx` ON `sessions` (`scheduled_task_id`);
--> statement-breakpoint
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
CREATE INDEX `exec_proc_session_idx` ON `execution_processes` (`session_id`);
--> statement-breakpoint
CREATE INDEX `exec_proc_status_idx` ON `execution_processes` (`status`);
--> statement-breakpoint
CREATE TABLE `process_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`process_id` text NOT NULL,
	`log_type` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`process_id`) REFERENCES `execution_processes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proc_logs_process_idx` ON `process_logs` (`process_id`);
--> statement-breakpoint
CREATE INDEX `proc_logs_timestamp_idx` ON `process_logs` (`timestamp`);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_keys_provider_idx` ON `api_keys` (`provider`);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`connector_type` text NOT NULL,
	`work_dir` text NOT NULL,
	`schedule_type` text NOT NULL,
	`cron_expression` text,
	`next_run_at` integer,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`inherit_context` integer DEFAULT false NOT NULL,
	`last_session_id` text,
	`last_agent_session_id` text,
	`agent_mode` text DEFAULT 'default' NOT NULL,
	`approval_mode` text DEFAULT 'manual' NOT NULL,
	`env` text,
	`enabled` integer DEFAULT true NOT NULL,
	`execution_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_enabled_idx` ON `scheduled_tasks` (`enabled`);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_next_run_idx` ON `scheduled_tasks` (`next_run_at`);
