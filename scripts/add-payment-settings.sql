-- Add payment configuration settings for IAP
-- These are global settings that apply to all in-app purchases

INSERT INTO settings (key, value, description) VALUES
('android_product_id', 'rexstream_plan', 'Google Play parent subscription product ID')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description;

INSERT INTO settings (key, value, description) VALUES
('ios_subscription_group_id', '21894749', 'Apple App Store subscription group ID')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description;

-- Note: Individual base plan IDs are stored per-plan in the plans table
COMMENT ON TABLE settings IS 'Global application settings including payment configuration';
