require('dotenv').config();
const pool = require('../src/config/db.js');
const { verifyCredentialOnChain } = require('../src/modules/verification/verification.service.js');

async function testTamperDetection() {
    const credentialId = 'urn:uuid:c893df1e-90e2-4d17-9a5d-1523f1155073'; 

    console.log('--- Tamper Detection Test Started ---');


    const originalRes = await pool.query(
        'SELECT root_hash FROM ledger.credentials WHERE credential_id = $1', 
        [credentialId]
    );

    if (originalRes.rows.length === 0) {
        console.error('Test failed: Credential not found in database.');
        process.exit(1);
    }

    const originalHash = originalRes.rows[0].root_hash;
    console.log('Original Hash:', originalHash);

    try {
        const lastChar = originalHash.slice(-1);
        const tamperedHash = originalHash.slice(0, -1) + (lastChar === 'f' ? 'e' : 'f');
        
        await pool.query(
            'UPDATE ledger.credentials SET root_hash = $1 WHERE credential_id = $2', 
            [tamperedHash, credentialId]
        );
        console.log(' Database Tampered! Modified Hash Set to:', tamperedHash);



        
        console.log('Testing verification service...');
        const result = await verifyCredentialOnChain(credentialId);
        console.log('Verification Response:', result);


        if (result.status === 'TAMPERED') {
            console.log('SUCCESS: Tamper detection test passed! System successfully detected the mismatch and returned TAMPERED.');
        } else {
            console.log('TEST FAILED: Expected status to be TAMPERED, but got:', result.status);
        }

    } catch (error) {
        console.error('Test encountered an error:', error.message);
    } finally {
       
        await pool.query(
            'UPDATE ledger.credentials SET root_hash = $1 WHERE credential_id = $2', 
            [originalHash, credentialId]
        );
        console.log('Original hash restored to database.');
        process.exit(0);
    }
}

testTamperDetection();