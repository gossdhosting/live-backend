-- Add default_payment_method column to stripe_subscriptions table
-- This stores the Stripe payment method object as JSONB for quick access

ALTER TABLE stripe_subscriptions
ADD COLUMN IF NOT EXISTS default_payment_method JSONB;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_payment_method
ON stripe_subscriptions USING GIN (default_payment_method);

COMMENT ON COLUMN stripe_subscriptions.default_payment_method IS 'Stripe payment method object (card details, etc.) stored as JSONB';
