require('dotenv').config();
const pool = require('../src/config/db');

async function viewDb() {
  try {
    console.log('\n======================================================');
    console.log('📊 DATABASE OVERVIEW — NSP HUNAR');
    console.log('======================================================');

    // 1. Tables
    const tables = await pool.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema IN ('auth', 'candidate', 'ledger')
      ORDER BY table_schema, table_name;
    `);
    console.log('\n📁 1. Active Tables:');
    console.table(tables.rows);

    // 2. Users
    const users = await pool.query(`
      SELECT user_id, email, role, hub_location_id, is_active, is_mfa_active, created_at 
      FROM auth.users 
      ORDER BY created_at DESC;
    `);
    console.log('\n👥 2. User Accounts:');
    console.table(users.rows);

    // 3. Candidates
    const candidates = await pool.query(`
      SELECT candidate_id, full_name, trade_category, testing_hub_id, created_at 
      FROM candidate.candidates 
      ORDER BY created_at DESC LIMIT 10;
    `);
    console.log('\n🎓 3. Recent Enrolled Candidates (Top 10):');
    console.table(candidates.rows);

    // 4. Assessments
    const assessments = await pool.query(`
      SELECT assessment_id, candidate_id, score, grade, status, submitted_at, approved_at 
      FROM candidate.assessment_records 
      ORDER BY created_at DESC LIMIT 10;
    `);
    console.log('\n📝 4. Recent Assessments (Top 10):');
    console.table(assessments.rows);

    // 5. Blockchain Ledger Queue
    const queue = await pool.query(`
      SELECT queue_id, credential_id, status, tx_hash, retry_count, last_attempt_at 
      FROM ledger.credential_queue 
      ORDER BY created_at DESC LIMIT 10;
    `);
    console.log('\n⛓️ 5. Blockchain Minting Queue (Top 10):');
    console.table(queue.rows);

    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ Database query error:', err.message);
  } finally {
    await pool.end();
  }
}

viewDb();
