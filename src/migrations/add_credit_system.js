import pkg from 'pg';
const { Pool } = pkg;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log('Starting migration: Add credit system tables...');

async function runMigration() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Add account_credit column to users table
    const checkUserCredit = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users'
      AND column_name = 'account_credit'
    `);

    if (checkUserCredit.rows.length === 0) {
      console.log('Adding account_credit column to users table...');
      await client.query(`
        ALTER TABLE users
        ADD COLUMN account_credit DECIMAL(10, 2) DEFAULT 0.00
      `);
      console.log('✓ Added account_credit column to users table');
    } else {
      console.log('✓ account_credit column already exists in users table');
    }

    // 2. Create credit_transactions table
    const checkCreditTransactions = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'credit_transactions'
    `);

    if (checkCreditTransactions.rows.length === 0) {
      console.log('Creating credit_transactions table...');
      await client.query(`
        CREATE TABLE credit_transactions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          transaction_type VARCHAR(50) NOT NULL,
          amount DECIMAL(10, 2) NOT NULL,
          balance_before DECIMAL(10, 2) NOT NULL,
          balance_after DECIMAL(10, 2) NOT NULL,
          description TEXT,
          reference_type VARCHAR(50),
          reference_id VARCHAR(255),
          admin_id INTEGER REFERENCES users(id),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for faster lookups
      await client.query(`
        CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id)
      `);
      await client.query(`
        CREATE INDEX idx_credit_transactions_type ON credit_transactions(transaction_type)
      `);
      await client.query(`
        CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at)
      `);

      console.log('✓ Created credit_transactions table with indexes');
    } else {
      console.log('✓ credit_transactions table already exists');
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
