-- Migration: Add separate sandbox and live keys
-- This allows storing both test and production keys simultaneously

-- Add new columns for sandbox (test) keys
ALTER TABLE payment_settings
ADD COLUMN IF NOT EXISTS stripe_publishable_key_sandbox TEXT,
ADD COLUMN IF NOT EXISTS stripe_secret_key_sandbox TEXT,
ADD COLUMN IF NOT EXISTS stripe_webhook_secret_sandbox TEXT;

-- Add new columns for live (production) keys
ALTER TABLE payment_settings
ADD COLUMN IF NOT EXISTS stripe_publishable_key_live TEXT,
ADD COLUMN IF NOT EXISTS stripe_secret_key_live TEXT,
ADD COLUMN IF NOT EXISTS stripe_webhook_secret_live TEXT;

-- Migrate existing keys to appropriate columns based on key prefix
-- If keys start with sk_test/pk_test, they go to sandbox columns
-- If keys start with sk_live/pk_live, they go to live columns
UPDATE payment_settings
SET
  stripe_publishable_key_sandbox = CASE
    WHEN stripe_publishable_key LIKE 'pk_test_%' THEN stripe_publishable_key
    ELSE stripe_publishable_key_sandbox
  END,
  stripe_secret_key_sandbox = CASE
    WHEN stripe_secret_key LIKE 'sk_test_%' THEN stripe_secret_key
    ELSE stripe_secret_key_sandbox
  END,
  stripe_webhook_secret_sandbox = CASE
    WHEN stripe_webhook_secret LIKE 'whsec_%' AND mode = 'sandbox' THEN stripe_webhook_secret
    ELSE stripe_webhook_secret_sandbox
  END,
  stripe_publishable_key_live = CASE
    WHEN stripe_publishable_key LIKE 'pk_live_%' THEN stripe_publishable_key
    ELSE stripe_publishable_key_live
  END,
  stripe_secret_key_live = CASE
    WHEN stripe_secret_key LIKE 'sk_live_%' THEN stripe_secret_key
    ELSE stripe_secret_key_live
  END,
  stripe_webhook_secret_live = CASE
    WHEN stripe_webhook_secret LIKE 'whsec_%' AND mode = 'live' THEN stripe_webhook_secret
    ELSE stripe_webhook_secret_live
  END
WHERE id = 1;

-- Note: We keep the old columns for now for backward compatibility
-- They will be automatically populated based on the active mode
