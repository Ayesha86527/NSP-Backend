require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/db.js');

async function runMigration() {
  try {

    const filePath = path.join(__dirname, '..', 'db', 'migrations', 'add_updated_at_to_credentials.sql');
    
    const sqlQuery = fs.readFileSync(filePath, 'utf8');

    console.log('Migration runnnning .. . ');
    await pool.query(sqlQuery);
    console.log(' done');
  } catch (err) {
    console.error(' err:', err.message);
  } finally {
    await pool.end();
  }
}

runMigration();