require('dotenv').config();
const pool=require('../src/config/db.js')


async function getCandidate() {
  try {
    const res = await pool.query('SELECT candidate_id, full_name FROM candidate.candidates LIMIT 5;');
    console.log('Available Candidates in Database:');
    console.table(res.rows);
  } catch (err) {
    console.error('Error fetching candidates:', err.message);
  } finally {
    await pool.end();
  }
}

getCandidate();