-- Create scheduled_tasks table for scheduling recurring and one-time tasks
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

-- Indexes for scheduled_tasks
CREATE INDEX `scheduled_tasks_enabled_idx` ON `scheduled_tasks` (`enabled`);
CREATE INDEX `scheduled_tasks_next_run_idx` ON `scheduled_tasks` (`next_run_at`);

-- Add scheduled_task_id column to sessions table
ALTER TABLE `sessions` ADD COLUMN `scheduled_task_id` text;

-- Index for scheduled_task_id
CREATE INDEX `sessions_scheduled_task_idx` ON `sessions` (`scheduled_task_id`);
