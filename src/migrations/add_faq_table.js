/**
 * Migration: Add FAQs table
 *
 * This creates the faqs table for managing frequently asked questions
 * that will be displayed to users in the Help section.
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

console.log('Starting migration: Add FAQs table...');

async function runMigration() {
  const client = new Client(config);

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if table already exists
    const checkTableQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'faqs';
    `;

    const result = await client.query(checkTableQuery);

    if (result.rows.length > 0) {
      console.log('✓ faqs table already exists');
    } else {
      console.log('Creating faqs table...');

      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS faqs (
          id SERIAL PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT NOT NULL,
          category VARCHAR(100),
          display_order INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;

      await client.query(createTableQuery);
      console.log('✓ Created faqs table');

      // Create index on display_order for faster sorting
      const createIndexQuery = `
        CREATE INDEX idx_faqs_display_order ON faqs(display_order);
      `;

      await client.query(createIndexQuery);
      console.log('✓ Created index on display_order');

      // Create index on is_active for filtering active FAQs
      const createActiveIndexQuery = `
        CREATE INDEX idx_faqs_is_active ON faqs(is_active);
      `;

      await client.query(createActiveIndexQuery);
      console.log('✓ Created index on is_active');

      // Create index on category for filtering by category
      const createCategoryIndexQuery = `
        CREATE INDEX idx_faqs_category ON faqs(category);
      `;

      await client.query(createCategoryIndexQuery);
      console.log('✓ Created index on category');

      // Add trigger to automatically update updated_at timestamp
      const createTriggerQuery = `
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';

        CREATE TRIGGER update_faqs_updated_at BEFORE UPDATE ON faqs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `;

      await client.query(createTriggerQuery);
      console.log('✓ Created trigger for updated_at column');

      // Insert sample FAQs
      const insertSampleQuery = `
        INSERT INTO faqs (question, answer, category, display_order, is_active) VALUES
        (
          'How do I start streaming to multiple platforms?',
          'To stream to multiple platforms, first connect your accounts in the Platforms section. Then create a new channel, add your streaming destinations, and click Start Stream. Our system will automatically broadcast your content to all connected platforms simultaneously.',
          'Streaming',
          0,
          true
        ),
        (
          'What video formats are supported?',
          'We support all major video formats including MP4, MOV, AVI, MKV, and FLV. For best results, we recommend using MP4 with H.264 video codec and AAC audio codec.',
          'Streaming',
          1,
          true
        ),
        (
          'How do I upgrade my plan?',
          'To upgrade your plan, go to the Plans section from the main menu. Select the plan that fits your needs and click Upgrade. You can pay via credit card or other supported payment methods. Your new limits will be available immediately after payment.',
          'Billing',
          2,
          true
        ),
        (
          'Can I schedule streams in advance?',
          'Yes! When creating or editing a channel, you can set a scheduled start time. The stream will automatically start at the specified time. Make sure your source media is ready and your channel is properly configured.',
          'Streaming',
          3,
          true
        ),
        (
          'What is the maximum concurrent stream limit?',
          'The concurrent stream limit depends on your subscription plan. Free plans typically allow 1 stream, while premium plans offer unlimited concurrent streams. Check your current plan in the Dashboard or Plans section.',
          'Account',
          4,
          true
        );
      `;

      await client.query(insertSampleQuery);
      console.log('✓ Inserted sample FAQs');
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
