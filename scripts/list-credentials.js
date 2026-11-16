require('dotenv').config();
const pool = require('../src/config/db.js');

async function listCredentials() {
  try {
    const res = await pool.query(`
      SELECT 
          c.credential_id,
          c.candidate_id,
          c.credential_subject,
          c.root_hash,
          c.issued_at,
          c.approved_at,
          c.status,
          mq.tx_hash
      FROM ledger.credentials c
      LEFT JOIN ledger.minting_queue mq 
          ON c.credential_id = mq.credential_id
      ORDER BY c.issued_at DESC
      LIMIT 2;
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