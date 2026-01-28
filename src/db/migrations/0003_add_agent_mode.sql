-- Add agent_mode column to sessions table
-- 'default' for normal agent operation
-- 'plan' for read-only planning mode (agent focuses on analysis, no file modifications)
ALTER TABLE `sessions` ADD COLUMN `agent_mode` text DEFAULT 'default' NOT NULL;
