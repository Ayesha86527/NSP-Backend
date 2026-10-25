/**
 * Apply one SQL migration file from db/migrations.
 *
 *   node scripts/run-migration.js auth/001_add_device_fingerprint_to_sessions.sql
 *
 * Uses the same DB_* environment variables (and SSL settings) as the API, so
 * it works unchanged against local PostgreSQL, an SSH tunnel (DB_HOST=127.0.0.1
 * DB_PORT=5433) or production RDS. Migrations must be idempotent
 * (IF NOT EXISTS) because there is no migration-history table yet.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

async function runMigration() {
    const migrationArg = process.argv[2];

    if (!migrationArg) {
        console.error('Usage: node scripts/run-migration.js <path-inside-db/migrations>.sql');
        process.exitCode = 1;
        return;
    }

    const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((key) => !process.env[key]);
    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const migrationsRoot = path.resolve(__dirname, '..', 'db', 'migrations');
    const filePath = path.resolve(migrationsRoot, migrationArg);

    // Prevent paths outside db/migrations from being executed.
    if (!filePath.startsWith(migrationsRoot + path.sep) || !filePath.endsWith('.sql')) {
        console.error('Invalid migration path. Provide a .sql file inside db/migrations.');
        process.exitCode = 1;
        return;
    }

    if (!fs.existsSync(filePath)) {
        console.error(`Migration file not found: ${filePath}`);
        process.exitCode = 1;
        return;
    }

    const pool = require('../src/config/db');

    try {
        const sqlQuery = fs.readFileSync(filePath, 'utf8');

        console.log(`Running migration: ${migrationArg}`);
        await pool.query(sqlQuery);
        console.log('Migration completed successfully.');
    } catch (error) {
        console.error('Migration failed:', error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

runMigration();
