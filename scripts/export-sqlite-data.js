import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'streaming.db');
const db = new Database(dbPath, { readonly: true });

console.log('📦 Exporting SQLite data...\n');

// Get list of all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

const exportData = {
  exportDate: new Date().toISOString(),
  database: 'streaming.db',
  tables: {}
};

// Export each table
tables.forEach(({ name }) => {
  console.log(`📋 Exporting table: ${name}`);
  const rows = db.prepare(`SELECT * FROM ${name}`).all();
  exportData.tables[name] = rows;
  console.log(`   ✓ ${rows.length} rows exported\n`);
});

// Save to JSON file
const exportDir = path.join(process.cwd(), 'data', 'backups');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const exportFile = path.join(exportDir, `sqlite-export-${timestamp}.json`);

fs.writeFileSync(exportFile, JSON.stringify(exportData, null, 2));

console.log('✅ Export completed!');
console.log(`📁 File saved to: ${exportFile}`);
console.log(`📊 Total tables exported: ${tables.length}`);

// Summary
console.log('\n📈 Summary:');
Object.entries(exportData.tables).forEach(([tableName, rows]) => {
  console.log(`   ${tableName}: ${rows.length} rows`);
});

db.close();
