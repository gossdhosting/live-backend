-- Add IAP Product ID fields to plans table
-- Allows admins to manually enter Google Play and App Store product IDs

ALTER TABLE plans ADD COLUMN IF NOT EXISTS android_product_id_monthly VARCHAR(255);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS android_product_id_yearly VARCHAR(255);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ios_product_id_monthly VARCHAR(255);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS ios_product_id_yearly VARCHAR(255);

COMMENT ON COLUMN plans.android_product_id_monthly IS 'Google Play subscription product ID for monthly billing';
COMMENT ON COLUMN plans.android_product_id_yearly IS 'Google Play subscription product ID for yearly billing';
COMMENT ON COLUMN plans.ios_product_id_monthly IS 'App Store subscription product ID for monthly billing';
COMMENT ON COLUMN plans.ios_product_id_yearly IS 'App Store subscription product ID for yearly billing';
