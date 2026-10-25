const { Pool } = require('pg');
const fs = require('fs');

const isProduction = process.env.NODE_ENV === 'production';

// Certificate validation is ON in production. For local/dev tunnels to RDS
// (hostname mismatch) set DB_SSL_REJECT_UNAUTHORIZED=false explicitly.
const rejectUnauthorized =
    process.env.DB_SSL_REJECT_UNAUTHORIZED !== undefined
        ? process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
        : isProduction;

const ssl =
    process.env.DB_SSL === 'true'
        ? {
              rejectUnauthorized,
              ...(process.env.DB_SSL_CA
                  ? { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8') }
                  : {})
          }
        : false;

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl,

    // NFR-PER-04: PostgreSQL connection pool tuning.
    max: Number(process.env.DB_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: 5000
});

// An error on an idle client (e.g. the database restarts) is emitted on the
// pool. Without a listener Node treats it as an uncaught exception and the
// whole API crashes (DoD: zero runtime exceptions).
pool.on('error', (error) => {
    console.error('[DB] Unexpected error on idle PostgreSQL client:', error.message);
});

module.exports = pool;
