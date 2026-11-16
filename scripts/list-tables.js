require('dotenv').config();
const pool=require('../src/config/db.js')


async function listTables() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'candidate' AND table_name = 'candidates'
        ORDER BY ordinal_position;
    `);
    console.log(' Database Tables:');
    console.table(res.rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

listTables();