require('dotenv').config();
const pool=require('../src/config/db.js')



async function listCredentials() {
  try {
    const res = await pool.query(`
      SELECT credential_id, candidate_id, status, issued_at 
      FROM ledger.credentials 
      ORDER BY issued_at DESC 
      LIMIT 5;
    `);
    console.log('Recent Credentials in Database:');
    console.table(res.rows);
  } catch (err) {
    console.error(' Error:', err.message);
  } finally {
    await pool.end();
  }
}

listCredentials();