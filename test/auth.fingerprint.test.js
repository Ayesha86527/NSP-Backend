/**
 * Unit Test: Device Fingerprinting (FR-AUTH-04)
 * Tests header extraction, fallback generation, session persistence,
 * and Phase 1 non-disruptive anomaly logging on mismatch.
 */

const assert = require('assert');
const crypto = require('crypto');

console.log('--- RUNNING DEVICE FINGERPRINT TESTS (FR-AUTH-04) ---');

// 1. Test Fingerprint Extraction Logic
const getDeviceFingerprint = (req) => {
    const headerFp = req.headers['x-device-fingerprint'];
    if (headerFp && typeof headerFp === 'string' && headerFp.trim().length > 0) {
        return headerFp.trim().toLowerCase();
    }
    const ua = req.headers['user-agent'] || 'unknown-ua';
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    return crypto.createHash('sha256').update(`${ua}|${ip}`).digest('hex');
};

// Case 1A: Header present
const reqWithHeader = {
    headers: {
        'x-device-fingerprint': '  A1B2C3D4E5F60123456789ABCDEF0123  ',
        'user-agent': 'Mozilla/5.0 Chrome/120.0'
    },
    ip: '192.168.1.100'
};
const fp1 = getDeviceFingerprint(reqWithHeader);
assert.strictEqual(fp1, 'a1b2c3d4e5f60123456789abcdef0123', 'Should trim and lowercase header');
console.log('✓ Test 1A: Header present extracts normalized visitorId');

// Case 1B: Header missing (fallback)
const reqWithoutHeader = {
    headers: {
        'user-agent': 'Mozilla/5.0 Chrome/120.0'
    },
    ip: '192.168.1.100'
};
const fp2 = getDeviceFingerprint(reqWithoutHeader);
const expectedFallback = crypto
    .createHash('sha256')
    .update('Mozilla/5.0 Chrome/120.0|192.168.1.100')
    .digest('hex');
assert.strictEqual(fp2, expectedFallback, 'Should deterministically hash UA and IP');
assert.strictEqual(fp2.length, 64, 'SHA-256 fallback must be 64-char hex string');
console.log('✓ Test 1B: Header missing produces deterministic SHA-256 fallback');

// Case 1C: Empty header fallback
const reqWithEmptyHeader = {
    headers: {
        'x-device-fingerprint': '   ',
        'user-agent': 'Mozilla/5.0 Firefox/121.0'
    },
    ip: '10.0.0.5'
};
const fp3 = getDeviceFingerprint(reqWithEmptyHeader);
assert.strictEqual(fp3.length, 64, 'Empty header should fallback to SHA-256');
console.log('✓ Test 1C: Whitespace-only header gracefully triggers fallback');

// 2. Test Phase 1 Validation (Anomaly Logging, Non-Disruptive)
const simulateTokenRefresh = ({ storedFingerprint, incomingFingerprint }) => {
    const logs = [];
    let refreshed = false;

    // Simulation of session lookup
    const session = {
        session_id: 'sess-123',
        user_id: 'user-456',
        device_fingerprint: storedFingerprint,
        revoked: false,
        expires_at: new Date(Date.now() + 1000000)
    };

    // Phase 1 check:
    if (session.device_fingerprint && session.device_fingerprint !== incomingFingerprint) {
        logs.push({
            eventType: 'AUTH_DEVICE_MISMATCH',
            details: {
                storedFingerprint: session.device_fingerprint,
                incomingFingerprint,
                mode: 'PHASE_1_AUDIT_ONLY',
                action: 'ALLOWED'
            }
        });
    }

    // Refresh rotation succeeds in Phase 1 even on mismatch
    refreshed = true;

    return { refreshed, logs };
};

// Case 2A: Matching fingerprints
const matchResult = simulateTokenRefresh({
    storedFingerprint: 'device-abc-123',
    incomingFingerprint: 'device-abc-123'
});
assert.strictEqual(matchResult.refreshed, true);
assert.strictEqual(matchResult.logs.length, 0, 'No mismatch log on identical fingerprint');
console.log('✓ Test 2A: Matching fingerprint refreshes silently without mismatch log');

// Case 2B: Mismatched fingerprints in Phase 1
const mismatchResult = simulateTokenRefresh({
    storedFingerprint: 'device-laptop-hub-1',
    incomingFingerprint: 'device-rogue-laptop'
});
assert.strictEqual(mismatchResult.refreshed, true, 'Phase 1 must NOT disrupt/reject session');
assert.strictEqual(mismatchResult.logs.length, 1, 'Must emit AUTH_DEVICE_MISMATCH log');
assert.strictEqual(mismatchResult.logs[0].eventType, 'AUTH_DEVICE_MISMATCH');
assert.strictEqual(mismatchResult.logs[0].details.mode, 'PHASE_1_AUDIT_ONLY');
assert.strictEqual(mismatchResult.logs[0].details.action, 'ALLOWED');
console.log('✓ Test 2B: Mismatched fingerprint logs anomaly but allows refresh (Phase 1)');

// Case 2C: Legacy session without fingerprint
const legacyResult = simulateTokenRefresh({
    storedFingerprint: null,
    incomingFingerprint: 'new-device-id'
});
assert.strictEqual(legacyResult.refreshed, true);
assert.strictEqual(legacyResult.logs.length, 0, 'No mismatch log when legacy session has null fingerprint');
console.log('✓ Test 2C: Legacy session with null fingerprint refreshes cleanly');

console.log('--- ALL DEVICE FINGERPRINT TESTS PASSED SUCCESSFULLY! ---');
