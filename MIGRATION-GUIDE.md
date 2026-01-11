# SQLite to PostgreSQL Migration Guide

This guide will help you migrate your streaming platform from SQLite to PostgreSQL.

## Why PostgreSQL?

- ✅ Better performance for concurrent connections
- ✅ ACID compliance with better transaction support
- ✅ Can be accessed by multiple servers simultaneously
- ✅ Better scalability for future multi-server architecture
- ✅ Advanced features (JSON columns, full-text search, etc.)

## Prerequisites

- Node.js 18+ installed
- PostgreSQL 12+ installed
- Access to your production server
- Backup of current SQLite database

## Migration Steps

### Step 1: Backup Current Database

```bash
cd /var/www/live-backend/data
cp streaming.db streaming.db.backup-$(date +%Y%m%d-%H%M%S)
```

### Step 2: Install PostgreSQL

**On Ubuntu 20.04:**

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib -y

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Check status
sudo systemctl status postgresql
```

### Step 3: Create PostgreSQL Database and User

```bash
# Switch to postgres user
sudo -u postgres psql

# In PostgreSQL prompt:
CREATE DATABASE streaming;
CREATE USER streamadmin WITH ENCRYPTED PASSWORD 'your_secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE streaming TO streamadmin;

# Grant schema permissions (PostgreSQL 15+)
\c streaming
GRANT ALL ON SCHEMA public TO streamadmin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO streamadmin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO streamadmin;

# Exit
\q
```

### Step 4: Create PostgreSQL Schema

```bash
cd /var/www/live-backend

# Run the schema creation script
psql -h localhost -U streamadmin -d streaming -f scripts/postgresql-schema.sql

# You'll be prompted for the password
```

### Step 5: Install pg Package

```bash
cd /var/www/live-backend
npm install pg
```

### Step 6: Configure Environment Variables

Create or update your `.env` file:

```bash
nano .env
```

Add these PostgreSQL configuration variables:

```env
# Database Configuration
DB_TYPE=postgresql

# PostgreSQL Connection
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=streaming
PG_USER=streamadmin
PG_PASSWORD=your_secure_password_here

# Keep SQLite path for backup reference
SQLITE_DB_PATH=./data/streaming.db
```

### Step 7: Migrate Data from SQLite to PostgreSQL

```bash
cd /var/www/live-backend

# Run the migration script
node scripts/migrate-to-postgresql.js
```

The script will:
- Connect to both SQLite and PostgreSQL
- Export all data from SQLite
- Convert data types (booleans, timestamps)
- Import data into PostgreSQL
- Verify row counts match

**Expected Output:**
```
🔄 Starting migration from SQLite to PostgreSQL

🔌 Testing PostgreSQL connection...
   ✅ Connected to PostgreSQL

📋 Migrating table: plans
   ✅ 3/3 rows migrated

📋 Migrating table: users
   ✅ 5/5 rows migrated

...

📊 Migration Summary:
   ✅ plans: SQLite=3, PostgreSQL=3
   ✅ users: SQLite=5, PostgreSQL=5
   ...

🎉 Migration completed successfully!
```

### Step 8: Update Database Import

**Option A: Conditional Import (Recommended for now)**

Update `src/models/database.js`:

```javascript
import dotenv from 'dotenv';
dotenv.config();

// Import the appropriate database module based on DB_TYPE
const dbType = process.env.DB_TYPE || 'sqlite';

let db;
if (dbType === 'postgresql') {
  const { default: pgDb } = await import('./database-postgresql.js');
  db = pgDb;
} else {
  const { default: sqliteDb } = await import('./database-sqlite.js');
  db = sqliteDb;
}

export default db;
```

**Option B: Direct PostgreSQL (For production after testing)**

Rename files:
```bash
mv src/models/database.js src/models/database-sqlite-old.js
mv src/models/database-postgresql.js src/models/database.js
```

### Step 9: Test the Application

```bash
# Stop the application
pm2 stop streaming-backend

# Start in development mode to see logs
NODE_ENV=development npm start

# Check for errors
# Test key functionality:
# - User login
# - Create channel
# - Start/stop stream
# - View channels
```

### Step 10: Deploy to Production

If everything works:

```bash
# Restart with PM2
pm2 restart streaming-backend

# Monitor logs
pm2 logs streaming-backend
```

## Verification Checklist

After migration, verify:

- [ ] Users can log in
- [ ] All existing channels are visible
- [ ] Channel settings are preserved
- [ ] RTMP destinations are intact
- [ ] Platform connections work
- [ ] Streams can start/stop
- [ ] Logs are being recorded
- [ ] Settings are accessible
- [ ] Media files are listed

## Performance Tuning

### PostgreSQL Configuration

Edit `/etc/postgresql/12/main/postgresql.conf`:

```conf
# Memory Settings (adjust based on your server RAM)
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
work_mem = 4MB

# Connections
max_connections = 100

# Checkpoints
checkpoint_completion_target = 0.9
wal_buffers = 16MB

# Logging (for debugging)
log_statement = 'mod'  # Log modifications
log_min_duration_statement = 1000  # Log slow queries (1 second+)
```

Restart PostgreSQL:
```bash
sudo systemctl restart postgresql
```

### Connection Pooling

The application uses `pg.Pool` with these settings:
- `max: 20` - Maximum connections
- `idleTimeoutMillis: 30000` - Close idle connections after 30s
- `connectionTimeoutMillis: 2000` - Connection timeout

## Rollback Plan

If you need to rollback to SQLite:

```bash
# Stop the application
pm2 stop streaming-backend

# Update .env
nano .env
# Change: DB_TYPE=sqlite
# Or remove DB_TYPE line

# Restart
pm2 restart streaming-backend
```

Your SQLite database is preserved at `data/streaming.db`.

## Common Issues and Solutions

### Issue 1: Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution:**
```bash
# Check if PostgreSQL is running
sudo systemctl status postgresql

# If not running, start it
sudo systemctl start postgresql

# Check if it's listening on 5432
sudo netstat -tulpn | grep 5432
```

### Issue 2: Authentication Failed

```
Error: password authentication failed for user "streamadmin"
```

**Solution:**
```bash
# Reset password
sudo -u postgres psql
ALTER USER streamadmin WITH PASSWORD 'new_secure_password';
\q

# Update .env with new password
```

### Issue 3: Permission Denied on Tables

```
Error: permission denied for table channels
```

**Solution:**
```bash
sudo -u postgres psql streaming
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO streamadmin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO streamadmin;
\q
```

### Issue 4: Prepared Statement Errors

If you see errors like "prepared statement already exists":

**Solution:** Restart the application. The connection pool will be refreshed.

## Monitoring PostgreSQL

### Check Active Connections

```sql
SELECT
  pid,
  usename,
  application_name,
  client_addr,
  state,
  query
FROM pg_stat_activity
WHERE datname = 'streaming';
```

### Check Database Size

```sql
SELECT
  pg_size_pretty(pg_database_size('streaming')) as size;
```

### Check Table Sizes

```sql
SELECT
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Backup Strategy

### Automated Daily Backups

Create a backup script `/root/backup-postgres.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/postgresql"
DATE=$(date +%Y%m%d-%H%M%S)
mkdir -p $BACKUP_DIR

# Backup database
pg_dump -h localhost -U streamadmin streaming | gzip > $BACKUP_DIR/streaming-$DATE.sql.gz

# Keep only last 7 days
find $BACKUP_DIR -name "streaming-*.sql.gz" -mtime +7 -delete

echo "Backup completed: streaming-$DATE.sql.gz"
```

Make executable and add to crontab:

```bash
chmod +x /root/backup-postgres.sh

# Add to crontab (daily at 2 AM)
crontab -e
# Add this line:
0 2 * * * /root/backup-postgres.sh >> /var/log/postgres-backup.log 2>&1
```

### Manual Backup

```bash
# Backup
pg_dump -h localhost -U streamadmin streaming > streaming-backup.sql

# Restore
psql -h localhost -U streamadmin streaming < streaming-backup.sql
```

## Next Steps

After successful migration:

1. Monitor application performance for 24-48 hours
2. Compare query performance with SQLite
3. Set up automated backups
4. Consider adding read replicas for scaling
5. Plan for multi-server architecture (if needed)

## Support

If you encounter issues:
1. Check application logs: `pm2 logs streaming-backend`
2. Check PostgreSQL logs: `sudo tail -f /var/log/postgresql/postgresql-12-main.log`
3. Verify database connection: `psql -h localhost -U streamadmin -d streaming`

## Summary

You have successfully:
- ✅ Backed up SQLite database
- ✅ Installed and configured PostgreSQL
- ✅ Created database schema
- ✅ Migrated all data
- ✅ Updated application configuration
- ✅ Verified data integrity

Your application is now ready for future scalability with PostgreSQL!
