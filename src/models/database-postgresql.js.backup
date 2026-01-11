import pg from 'pg';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

const { Pool } = pg;

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'streaming',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    logger.error('Failed to connect to PostgreSQL', { error: err.message });
    process.exit(1);
  } else {
    logger.info('✅ Connected to PostgreSQL database');
  }
});

// Wrapper class to match SQLite API for minimal code changes
class DatabaseWrapper {
  constructor(pool) {
    this.pool = pool;
  }

  // Execute a query (no results expected, like CREATE/INSERT/UPDATE/DELETE)
  async exec(sql) {
    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  // Prepare a statement for execution
  prepare(sql) {
    return new PreparedStatement(this.pool, sql);
  }

  // Run a transaction
  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Close the connection pool
  async close() {
    await this.pool.end();
  }
}

// PreparedStatement class to match SQLite API
class PreparedStatement {
  constructor(pool, sql) {
    this.pool = pool;
    // Convert SQLite ? placeholders to PostgreSQL $1, $2, etc.
    let paramCount = 0;
    this.sql = sql.replace(/\?/g, () => `$${++paramCount}`);
  }

  // Execute and return all rows
  async all(...params) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(this.sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  // Execute and return first row
  async get(...params) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(this.sql, params);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  // Execute and return result info (for INSERT/UPDATE/DELETE)
  async run(...params) {
    const client = await this.pool.connect();
    try {
      // For INSERT statements, add RETURNING id if not already present
      let sql = this.sql;
      if (sql.trim().toUpperCase().startsWith('INSERT') && !sql.toUpperCase().includes('RETURNING')) {
        sql = sql.trim() + ' RETURNING id';
      }

      const result = await client.query(sql, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id || null,
      };
    } finally {
      client.release();
    }
  }
}

// For synchronous operations, we need to wrap in async/await
// This wrapper provides sync-like API but uses promises internally
const db = new DatabaseWrapper(pool);

// Export both the wrapper and the raw pool
export default db;
export { pool };
