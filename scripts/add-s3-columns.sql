-- PostgreSQL migration to add S3 support to media_files table

-- Add S3-related columns to media_files table
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS s3_key VARCHAR(500) DEFAULT NULL;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS s3_bucket VARCHAR(255) DEFAULT NULL;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS s3_region VARCHAR(50) DEFAULT NULL;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS storage_type VARCHAR(20) DEFAULT 'local';  -- 'local' or 's3'

-- Add index for S3 key lookups
CREATE INDEX IF NOT EXISTS idx_media_files_s3_key ON media_files(s3_key);
CREATE INDEX IF NOT EXISTS idx_media_files_storage_type ON media_files(storage_type);

-- Log the migration
INSERT INTO system_logs (level, message, metadata, created_at)
VALUES ('info', 'Migration: Added S3 support columns to media_files table', '{}', NOW())
ON CONFLICT DO NOTHING;
