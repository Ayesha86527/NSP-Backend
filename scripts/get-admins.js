require('dotenv').config();
const pool = require('../src/config/db.js');

async function verifyExistingData() {
  try {
    const schemas = ['auth', 'candidate', 'ledger'];
    
    for (const schema of schemas) {
      console.log(`\n================ SCHEMA: ${schema} ================`);
      const tablesRes = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = $1;
      `, [schema]);

      for (const row of tablesRes.rows) {
        const tableName = row.table_name;
        try {
          const countRes = await pool.query(`SELECT COUNT(*) FROM "${schema}"."${tableName}";`);
          console.log(`Table: ${tableName} --> Total Rows: ${countRes.rows[0].count}`);
        } catch (e) {
          console.log(` Table: ${tableName} --> (Could not count rows)`);
        }
      }
    }
  } catch (err) {
    console.error('Error inspecting database:', err.message);
  } finally {
    await pool.end();
  }
}

verifyExistingData();