const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');


async function runMigration() {
  try {
    const filePath = path.join(process.cwd(), 'db', 'migrations', 'ledger', '001_create_ledger_tables.sql');
    const sql = fs.readFileSync(filePath, 'utf8');
    
    console.log('Running migration with SSL encryption...');
    await pool.query(sql);
    console.log(' Migration executed successfully on AWS RDS!');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

runMigration();