/**
 * Migration: Add rtmp_input_connected column to channels table
 *
 * This column tracks whether an RTMP input stream is currently connected
 * to a channel, allowing the UI to show "Receiving Input" status.
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

console.log('Starting migration: Add rtmp_input_connected column...');

async function runMigration() {
  const client = new Client(config);

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if column already exists
    const checkColumnQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'channels'
      AND column_name = 'rtmp_input_connected';
    `;

    const result = await client.query(checkColumnQuery);

    if (result.rows.length > 0) {
      console.log('✓ rtmp_input_connected column already exists');
    } else {
      console.log('Adding rtmp_input_connected column...');

      const addColumnQuery = `
        ALTER TABLE channels
        ADD COLUMN rtmp_input_connected BOOLEAN DEFAULT FALSE;
      `;

      await client.query(addColumnQuery);
      console.log('✓ Added rtmp_input_connected column to channels table');

      // Add comment for documentation
      const addCommentQuery = `
        COMMENT ON COLUMN channels.rtmp_input_connected IS 'Tracks whether an RTMP input stream is currently connected to this channel';
      `;

      await client.query(addCommentQuery);
      console.log('✓ Added column comment');
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
