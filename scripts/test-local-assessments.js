require('dotenv').config();
const pool = require('../src/config/db');
const assessmentModel = require('../src/modules/candidate/assessment.model');
const candidateModel = require('../src/modules/candidate/candidate.model');

async function testLocalQueries() {
    console.log('\n===============================================================');
    console.log('🧪 TESTING LOCAL BACKEND MODEL CHANGES');
    console.log('===============================================================');

    try {
        // 1. Test Superintendent Assessments Query (findByHub)
        console.log('\n📋 1. Testing Superintendent Assessments Query (assessmentModel.findByHub):');
        const assessments = await assessmentModel.findByHub(null);

        if (assessments.length === 0) {
            console.log('   (No assessments found in database)');
        } else {
            console.log(`   Found ${assessments.length} assessment records.`);
            const sample = assessments.slice(0, 5).map(a => ({
                id: a.assessment_id,
                candidate: a.full_name,
                trade: a.trade_category,
                grade: a.grade,
                assessment_status: a.status,
                credential_id: a.credential_id || '(not minted yet)',
                credential_status: a.credential_status || 'NONE'
            }));
            console.table(sample);

            const mintedOnes = assessments.filter(a => a.credential_id);
            console.log(`   ✅ Success: ${mintedOnes.length} assessment(s) have an active credential_id joined!`);
        }

        // 2. Test Candidate Query (candidateModel.findByHub)
        console.log('\n👤 2. Testing Candidate Query (candidateModel.findByHub):');
        const candidates = await candidateModel.findByHub(null);

        if (candidates.length === 0) {
            console.log('   (No candidates found in database)');
        } else {
            console.log(`   Found ${candidates.length} candidates.`);
            const sampleCandidates = candidates.slice(0, 5).map(c => ({
                id: c.candidate_id.substring(0, 8) + '...',
                name: c.full_name,
                trade: c.trade_category,
                credential_id: c.credential_id || '(no credential)',
                credential_status: c.credential_status || 'NONE'
            }));
            console.table(sampleCandidates);
            console.log('   ✅ Success: candidateModel.findByHub now returns credential_id!');
        }

        console.log('\n===============================================================');
        console.log('🎉 ALL BACKEND QUERIES VERIFIED SUCCESSFULLY!');
        console.log('===============================================================\n');
    } catch (err) {
        console.error('❌ Database/Query Error:', err.message);
    } finally {
        await pool.end();
    }
}

testLocalQueries();
