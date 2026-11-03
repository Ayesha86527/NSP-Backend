
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { stubModule } = require('./helpers/testEnv');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const FINGERPRINT = 'test-device-fingerprint';
const CREDENTIAL = 'test-device-credential';

const auditLogs = [];
let lockdownEnabled;
let registeredDevices;
let queryCalls;

const fakePool = {
    query: async (sql, params = []) => {
        queryCalls.push({ sql, params });

        if (sql.includes('auth.hub_device_lockdowns')) {
            return {
                rows: [{ is_locked: lockdownEnabled }],
                rowCount: 1
            };
        }

        if (sql.includes('auth.authorized_devices')) {
            return {
                rows: registeredDevices.map(device => ({ ...device })),
                rowCount: registeredDevices.length
            };
        }

        throw new Error(`Unexpected database query: ${sql}`);
    }
};

const auditModelMock = {
    createAuditLog: async data => {
        auditLogs.push(data);
        return { audit_id: 'test-audit-id' };
    }
};

const authModelMock = {};
const backupCodeModelMock = {
    generateBackupCodesIfAbsent: async () => [],
    verifyAndConsumeBackupCode: async () => ({ success: false }),
    getBackupCodeStatus: async () => ({})
};

const mfaSecretMock = {
    encryptMfaSecret: () => 'encrypted-test-secret',
    createEncryptedMfaSecret: () => ({
        secret: 'TEST_SECRET',
        encryptedSecret: 'encrypted-test-secret',
        otpauthUrl: 'otpauth://test'
    })
};

const otplibMock = {
    verify: async () => ({ valid: true }),
    generateSecret: () => 'TEST_SECRET',
    generateURI: () => 'otpauth://test'
};

// Stub dependencies before loading auth.service.
stubModule('config/db', fakePool);
stubModule('modules/auth/auth.model', authModelMock);
stubModule('modules/auth/backupCode.model', backupCodeModelMock);
stubModule('modules/auth/mfaSecret', mfaSecretMock);
stubModule('modules/auth/audit.model', auditModelMock);

// Intercept otplib.
const Module = require('node:module');
const originalModuleLoad = Module._load;

Module._load = function (request, parent, isMain) {
    if (request === 'otplib') {
        return otplibMock;
    }

    return originalModuleLoad.call(this, request, parent, isMain);
};

let authService;

try {
    authService = require('../src/modules/auth/auth.service');
} finally {
    Module._load = originalModuleLoad;
}

const { authorizeHubDevice } = authService;

const createUser = overrides => ({
    user_id: USER_ID,
    email: 'tester@nsp.local',
    role: 'TRADE_TESTER',
    hub_location_id: 1,
    ...overrides
});

const createDevice = overrides => ({
    device_id: DEVICE_ID,
    device_fingerprint: FINGERPRINT,
    device_credential_hash: crypto
        .createHash('sha256')
        .update(CREDENTIAL)
        .digest('hex'),
    edr_status: 'compliant',
    revoked: false,
    ...overrides
});

const authorize = overrides =>
    authorizeHubDevice({
        user: createUser(),
        deviceFingerprint: FINGERPRINT,
        deviceCredential: CREDENTIAL,
        ...overrides
    });

beforeEach(() => {
    lockdownEnabled = false;
    registeredDevices = [createDevice()];
    queryCalls = [];
    auditLogs.length = 0;

    process.env.DEVICE_ENFORCEMENT = 'audit';
});

// 1. Missing user must be rejected without database access.
test('rejects authorization when user is missing', async () => {
    const result = await authorize({ user: null });

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.message, 'Account unavailable.');
    assert.equal(queryCalls.length, 0);
});

// 2. Super Admin must be exempt from hub device enforcement.
test('allows SUPER_ADMIN without device database checks', async () => {
    const result = await authorize({
        user: createUser({
            role: 'SUPER_ADMIN',
            hub_location_id: null
        })
    });

    assert.deepEqual(result, {
        allowed: true,
        reason: 'SUPER_ADMIN_EXEMPT'
    });

    assert.equal(queryCalls.length, 0);
});

// 3. Invalid enforcement configuration must throw.
test('rejects invalid DEVICE_ENFORCEMENT configuration', async () => {
    process.env.DEVICE_ENFORCEMENT = 'invalid';

    await assert.rejects(
        authorize(),
        /Invalid DEVICE_ENFORCEMENT configuration/
    );

    assert.equal(queryCalls.length, 0);
});

// 4. Hub lockdown must block access.
test('blocks access when hub lockdown is enabled', async () => {
    lockdownEnabled = true;

    const result = await authorize();

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(
        result.message,
        'Access from this hub is currently locked down.'
    );

    assert.equal(queryCalls.length, 1);
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].eventType, 'AUTH_DEVICE_BLOCKED');
    assert.equal(auditLogs[0].details.reason, 'HUB_LOCKDOWN');
});

// 5. Matching fingerprint and credential with compliant EDR.
test('allows a registered device with matching identifiers and compliant EDR', async () => {
    const result = await authorize();

    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'AUTHORIZED_DEVICE');
    assert.equal(result.deviceId, DEVICE_ID);
    assert.equal(queryCalls.length, 2);
    assert.equal(auditLogs.length, 0);
});

// 6. A device that does not exist must be logged in audit mode but allowed.
test('allows an unregistered device in audit mode with a warning', async () => {
    registeredDevices = [];

    const result = await authorize();

    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'DEVICE_NOT_REGISTERED');
    assert.equal(result.warning, false);

    assert.equal(auditLogs.length, 1);
    assert.equal(
        auditLogs[0].eventType,
        'AUTH_DEVICE_AUTHORIZATION_WARNING'
    );
    assert.equal(auditLogs[0].details.reason, 'DEVICE_NOT_REGISTERED');
});

// 7. Warn mode must allow the request and mark the warning.
test('allows unauthorized device with warning in warn mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'warn';
    registeredDevices = [];

    const result = await authorize();

    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'DEVICE_NOT_REGISTERED');
    assert.equal(result.warning, true);
    assert.equal(auditLogs.length, 1);
});

// 8. Enforce mode must reject an unregistered device.
test('blocks unregistered device in enforce mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'enforce';
    registeredDevices = [];

    const result = await authorize();

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(
        result.message,
        'This device is not authorized for this hub.'
    );
    assert.equal(auditLogs.length, 1);
});

// 9. Revoked devices must be blocked even in audit mode.
test('blocks revoked device regardless of enforcement mode', async () => {
    registeredDevices = [createDevice({ revoked: true })];

    const result = await authorize();

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.message, 'This device has been revoked.');
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].details.reason, 'DEVICE_REVOKED');
});

// 10. Fingerprint and credential must identify the same device.
test('rejects mismatched fingerprint and credential device identifiers in enforce mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'enforce';

    const otherDeviceId = '44444444-4444-4444-8444-444444444444';

    registeredDevices = [
        createDevice({
            device_id: DEVICE_ID
        }),
        createDevice({
            device_id: otherDeviceId,
            device_fingerprint: 'another-device-fingerprint',
            device_credential_hash: crypto
                .createHash('sha256')
                .update('another-device-credential')
                .digest('hex')
        })
    ];

    const result = await authorize({
        deviceCredential: 'another-device-credential'
    });

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(auditLogs[0].details.reason, 'DEVICE_FINGERPRINT_MISMATCH');
});

// 11. Non-compliant EDR must not be treated as authorized.
test('blocks non-compliant EDR device in enforce mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'enforce';

    registeredDevices = [
        createDevice({ edr_status: 'non_compliant' })
    ];

    const result = await authorize();

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(
        auditLogs[0].details.reason,
        'EDR_NOT_COMPLIANT'
    );
});

// 12. Missing credential must not authorize a device.
test('rejects missing device credential in enforce mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'enforce';

    const result = await authorize({
        deviceCredential: null
    });

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(
        auditLogs[0].details.reason,
        'INVALID_DEVICE_CREDENTIAL'
    );
});

// 13. Missing fingerprint must not authorize a device.
test('rejects missing fingerprint in enforce mode', async () => {
    process.env.DEVICE_ENFORCEMENT = 'enforce';

    const result = await authorize({
        deviceFingerprint: null,
        ipAddress: null
    });

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 403);
    assert.equal(
        auditLogs[0].details.reason,
        'DEVICE_NOT_REGISTERED'
    );
});
