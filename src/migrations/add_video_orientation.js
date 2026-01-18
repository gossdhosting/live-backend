/**
 * Migration: Add video_orientation column to rtmp_templates table
 *
 * This adds support for portrait (9:16) and landscape (16:9) video orientations
 * for custom RTMP streaming templates.
 */

import pg from 'pg';
const { Client } = pg;

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'streaming',
  user: process.env.DB_USER || 'streaming_user',
  password: process.env.DB_PASSWORD || 'streaming_password',
};

console.log('Starting migration: Add video_orientation to rtmp_templates...');

async function runMigration() {
  const client = new Client(config);

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if column already exists
    const checkColumnQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'rtmp_templates'
      AND column_name = 'video_orientation';
    `;

    const result = await client.query(checkColumnQuery);

    if (result.rows.length > 0) {
      console.log('✓ video_orientation column already exists in rtmp_templates table');
    } else {
      console.log('Adding video_orientation column to rtmp_templates table...');

      // Add the video_orientation column
      // Using VARCHAR instead of ENUM for better flexibility
      // Default is '16:9' (landscape - current behavior)
      const addColumnQuery = `
        ALTER TABLE rtmp_templates
        ADD COLUMN video_orientation VARCHAR(10) DEFAULT '16:9' NOT NULL;
      `;

      await client.query(addColumnQuery);
      console.log('✓ Added video_orientation column to rtmp_templates table');

      // Add a check constraint to ensure only valid values
      const addConstraintQuery = `
        ALTER TABLE rtmp_templates
        ADD CONSTRAINT video_orientation_check
        CHECK (video_orientation IN ('16:9', '9:16'));
      `;

      await client.query(addConstraintQuery);
      console.log('✓ Added check constraint for video_orientation values');

      // Update existing records to have default '16:9'
      const updateExistingQuery = `
        UPDATE rtmp_templates
        SET video_orientation = '16:9'
        WHERE video_orientation IS NULL;
      `;

      await client.query(updateExistingQuery);
      console.log('✓ Updated existing records with default video_orientation');
    }

    console.log('Migration completed successfully!');

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await client.end();
    console.log('Database connection closed');
  }
}

// Run the migration
runMigration()
  .then(() => {
    console.log('✅ Migration completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });
