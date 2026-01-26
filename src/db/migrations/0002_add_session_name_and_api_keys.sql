-- Add session_name column to sessions table
ALTER TABLE `sessions` ADD COLUMN `session_name` text;

-- Create api_keys table
CREATE TABLE `api_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `api_key` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `api_keys_provider_idx` ON `api_keys` (`provider`);

-- Migrate existing status values
UPDATE `sessions` SET `status` = 'in_progress' WHERE `status` = 'running';
UPDATE `sessions` SET `status` = 'failed' WHERE `status` = 'killed';
