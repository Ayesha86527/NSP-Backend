
const pool=require('../src/config/db.js')

async function inspectUsers() {
  try {
    const res = await pool.query("SELECT * FROM auth.users LIMIT 2;");
    console.log('Auth Users Table Structure & Data:');
    console.log(res.rows);
  } catch (err) {
    console.error(' Error:', err.message);
  } finally {
    await pool.end();
  }
}

inspectUsers();