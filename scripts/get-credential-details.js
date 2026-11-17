require('dotenv').config();
const pool = require('../src/config/db');

const targetId = process.argv[2] || 'urn:uuid:a8482d43-182c-4a21-b5b6-437eb03ad506';

async function getDetails() {
  try {
    console.log(`\n======================================================`);
    console.log(`🔍 FETCHING ALL AWS RECORDS FOR:`);
    console.log(`   ${targetId}`);
    console.log(`======================================================`);

    // 1. Ledger Credential Record
    const credRes = await pool.query(`
      SELECT credential_id, candidate_id, status, issued_at 
      FROM ledger.credentials 
      WHERE credential_id = $1;
    `, [targetId]);

    console.log('\n📜 1. LEDGER CREDENTIAL RECORD:');
    if (credRes.rows.length === 0) {
      console.log('   (No record found in ledger.credentials with this ID)');
    } else {
      console.table(credRes.rows);
    }

    const candidateId = credRes.rows[0]?.candidate_id || '0475ba41-0aa8-43ce-90df-7e2f3e006b89';

    // 2. Candidate Record
    const candRes = await pool.query(`
      SELECT candidate_id, full_name, father_name, trade_category, testing_hub_id, date_of_birth, created_at 
      FROM candidate.candidates 
      WHERE candidate_id = $1;
    `, [candidateId]);

    console.log('\n🎓 2. CANDIDATE PROFILE RECORD:');
    if (candRes.rows.length === 0) {
      console.log('   (Candidate profile not found)');
    } else {
      console.table(candRes.rows);
    }

    // 3. Assessment Record (Grading, Tester, Superintendent)
    const assessRes = await pool.query(`
      SELECT assessment_id, candidate_id, score, grade, status, tester_user_id, superintendent_user_id, submitted_at, approved_at 
      FROM candidate.assessment_records 
      WHERE candidate_id = $1;
    `, [candidateId]);

    console.log('\n📝 3. ASSESSMENT RECORD (GRADES & APPROVAL):');
    if (assessRes.rows.length === 0) {
      console.log('   (Assessment record not found)');
    } else {
      console.table(assessRes.rows);
    }

    // 4. Blockchain Minting Queue & Polygon TX Hash
    const queueRes = await pool.query(`
      SELECT id, credential_id, status, tx_hash, attempt_count, updated_at 
      FROM ledger.minting_queue 
      WHERE credential_id = $1;
    `, [targetId]);

    console.log('\n⛓️ 4. POLYGON BLOCKCHAIN TRANSACTION RECORD:');
    if (queueRes.rows.length === 0) {
      console.log('   (No entry found in ledger.credential_queue)');
    } else {
      console.table(queueRes.rows);
    }

    console.log('======================================================\n');
  } catch (err) {
    console.error('❌ Error fetching records:', err.message);
  } finally {
    await pool.end();
  }
}

getDetails();
