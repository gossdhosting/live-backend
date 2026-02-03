import pkg from 'pg';
const { Pool } = pkg;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log('Starting migration: Add hls_embed_enabled to plans table...');

async function runMigration() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if column exists in plans table
    const checkColumn = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'plans'
      AND column_name = 'hls_embed_enabled'
    `);

    if (checkColumn.rows.length === 0) {
      console.log('Adding hls_embed_enabled column to plans table...');
      await client.query(`
        ALTER TABLE plans
        ADD COLUMN hls_embed_enabled BOOLEAN DEFAULT FALSE
      `);
      console.log('✓ Added hls_embed_enabled column to plans table');
    } else {
      console.log('✓ hls_embed_enabled column already exists in plans table');
    }

    await client.query('COMMIT');
    console.log('Migration completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
