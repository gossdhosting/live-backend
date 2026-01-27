# Database Migrations

This file tracks all database schema changes for manual execution.

## Migration: Add Cloud Storage Plan Setting
**Date**: 2026-01-27
**Description**: Add cloud_storage_enabled column to plans table to control whether users can upload to AWS S3 or use local storage based on their subscription plan.

### SQL Commands

```sql
-- Add cloud_storage_enabled column to plans table
ALTER TABLE plans ADD COLUMN cloud_storage_enabled BOOLEAN DEFAULT false;

-- Configure existing plans
-- Free plan: Local Storage
UPDATE plans SET cloud_storage_enabled = false WHERE name = 'Free';

-- Test plan: Local Storage
UPDATE plans SET cloud_storage_enabled = false WHERE name = 'test';

-- Basic plan: AWS S3 Cloud Storage
UPDATE plans SET cloud_storage_enabled = true WHERE name = 'Basic';

-- Pro plan: AWS S3 Cloud Storage
UPDATE plans SET cloud_storage_enabled = true WHERE name = 'Pro';

-- Enterprise plan: AWS S3 Cloud Storage
UPDATE plans SET cloud_storage_enabled = true WHERE name = 'Enterprise';

-- Master Plan: AWS S3 Cloud Storage
UPDATE plans SET cloud_storage_enabled = true WHERE name = 'Master Plan';
```

### Verification

```sql
-- Verify the column was added and values are correct
SELECT id, name, cloud_storage_enabled FROM plans ORDER BY price_monthly ASC;
```

### Rollback (if needed)

```sql
-- Remove the column
ALTER TABLE plans DROP COLUMN cloud_storage_enabled;
```

---

## Migration: Add User cloud_storage_enabled in SELECT queries
**Date**: 2026-01-27
**Description**: Updated User.findById() queries to include cloud_storage_enabled from plans table.

### Files Modified
- `/var/www/backend/src/models/User.js` (Lines with User.findById queries)

### SQL Query Changes
Added to SELECT statements:
```sql
p.cloud_storage_enabled
```

---
