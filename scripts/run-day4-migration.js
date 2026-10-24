require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db.js');

async function runMigration() {
  try {
    const filePath = path.join(
      __dirname,
      '..',
      'db',
      'migrations',
      'day4',
      '001_complete_schema_ddl.sql'
    );

    const sqlQuery = fs.readFileSync(filePath, 'utf8');

    console.log('Running Day 4 migration...');
    await pool.query(sqlQuery);
    console.log('Day 4 migration completed successfully.');
  } catch (err) {
    console.error('Day 4 migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runMigration();
