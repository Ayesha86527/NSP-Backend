const { Pool } = require('pg');
const fs = require('fs');

const ssl = process.env.DB_SSL === 'true'
    ? {
        rejectUnauthorized: false,
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
    ssl
});

module.exports = pool;