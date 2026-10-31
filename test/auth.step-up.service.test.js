
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

// Load test environment before importing application modules.
const { stubModule } = require('./helpers/testEnv');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SCOPE = 'APPROVE_ASSESSMENT';

const storedTokens = [];
const auditLogs = [];

let fakeUser;
let totpValid;
let backupCodeValid;
let failedMfaAttempts;
let resetMfaCalled;
let backupVerificationCalled;

// Generate a valid AES-256-GCM encrypted MFA secret.
// This matches the format expected by auth.service.js:
// iv:authenticationTag:encryptedSecret
const createEncryptedTestSecret = () => {
    const keyHex = process.env.MFA_ENCRYPTION_KEY;

    if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
        throw new Error('Test MFA encryption key is missing or invalid');
    }

    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        Buffer.from(keyHex, 'hex'),
        iv
    );

    const encrypted = Buffer.concat([
        cipher.update('TEST_MFA_SECRET', 'utf8'),
        cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    return [
        iv.toString('hex'),
        tag.toString('hex'),
        encrypted.toString('hex')
    ].join(':');
};

const fakePool = {
    query: async (sql, params = []) => {
        if (sql.includes('FROM auth.users')) {
            return {
                rows: fakeUser ? [{ ...fakeUser }] : [],
                rowCount: fakeUser ? 1 : 0
            };
        }

        if (sql.includes('INSERT INTO auth.step_up_tokens')) {
            storedTokens.push({
                tokenHash: params[0],
                userId: params[1],
                sessionId: params[2],
                scope: params[3],
                expiresAt: params[4]
            });

            return {
                rows: [],
                rowCount: 1
            };
        }

        throw new Error(`Unexpected database query: ${sql}`);
    }
};

const authModelMock = {
    recordFailedMfa: async () => {
        failedMfaAttempts += 1;

        return {
            failed_mfa_attempts: failedMfaAttempts,
            mfa_locked_until:
                failedMfaAttempts >= 5
                    ? new Date(Date.now() + 15 * 60 * 1000)
                    : null
        };
    },

    resetFailedMfa: async () => {
        resetMfaCalled = true;
        failedMfaAttempts = 0;
    }
};

const backupCodeModelMock = {
    verifyAndConsumeBackupCode: async () => {
        backupVerificationCalled = true;

        return {
            success: backupCodeValid
        };
    }
};

const mfaSecretMock = {
    encryptMfaSecret: () => 'encrypted-test-secret',

    createEncryptedMfaSecret: () => ({
        secret: 'TEST_MFA_SECRET',
        encryptedSecret: 'encrypted-test-secret',
        otpauthUrl: 'otpauth://test'
    })
};

const otplibMock = {
    verify: async () => ({
        valid: totpValid
    }),
    generateSecret: () => 'TEST_MFA_SECRET',
    generateURI: () => 'otpauth://test'
};

const auditModelMock = {
    createAuditLog: async data => {
        auditLogs.push(data);
        return { audit_id: 'test-audit-id' };
    }
};

// Stub local application dependencies before loading auth.service.
stubModule('config/db', fakePool);
stubModule('modules/auth/auth.model', authModelMock);
stubModule('modules/auth/backupCode.model', backupCodeModelMock);
stubModule('modules/auth/mfaSecret', mfaSecretMock);
stubModule('modules/auth/audit.model', auditModelMock);

// Intercept the installed otplib package directly.
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
    // Restore Node's normal module loading after auth.service is loaded.
    Module._load = originalModuleLoad;
}

const createUser = overrides => ({
    user_id: USER_ID,
    email: 'test@nsp.local',
    role: 'SUPER_ADMIN',
    hub_location_id: null,
    password_hash: 'test-password-hash',
    mfa_secret: createEncryptedTestSecret(),
    is_mfa_active: true,
    mfa_enrollment_pending: false,
    admin_locked: false,
    token_version: 0,
    failed_login_attempts: 0,
    locked_until: null,
    failed_mfa_attempts: 0,
    mfa_locked_until: null,
    ...overrides
});

beforeEach(() => {
    storedTokens.length = 0;
    auditLogs.length = 0;

    fakeUser = createUser();

    totpValid = true;
    backupCodeValid = true;

    failedMfaAttempts = 0;
    resetMfaCalled = false;
    backupVerificationCalled = false;
});

test('TOTP: creates a valid five-minute step-up token', async () => {
    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456',
        ipAddress: '127.0.0.1'
    });

    assert.equal(result.success, true);
    assert.equal(result.tokenType, 'Bearer');
    assert.equal(result.expiresIn, 300);
    assert.ok(result.stepUpToken);

    assert.equal(storedTokens.length, 1);
    assert.equal(storedTokens[0].userId, USER_ID);
    assert.equal(storedTokens[0].sessionId, SESSION_ID);
    assert.equal(storedTokens[0].scope, SCOPE);
    assert.equal(storedTokens[0].tokenHash.length, 64);

    assert.equal(resetMfaCalled, true);

    const successLog = auditLogs.find(
        log => log.eventType === 'AUTH_STEP_UP_SUCCESS'
    );

    assert.ok(successLog);
});

test('Backup code: creates a step-up token after successful verification', async () => {
    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        backupCode: 'TEST-BACKUP-CODE'
    });

    assert.equal(result.success, true);
    assert.ok(result.stepUpToken);

    assert.equal(backupVerificationCalled, true);
    assert.equal(storedTokens.length, 1);
});

test('Invalid TOTP: rejects the request and records a failed attempt', async () => {
    totpValid = false;

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '000000'
    });

    assert.equal(result.success, false);
    assert.equal(result.message, 'Invalid MFA code');
    assert.equal(failedMfaAttempts, 1);
    assert.equal(storedTokens.length, 0);

    assert.ok(
        auditLogs.some(
            log => log.eventType === 'AUTH_STEP_UP_FAILED'
        )
    );
});

test('Invalid backup code: rejects the request', async () => {
    backupCodeValid = false;

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        backupCode: 'INVALID-CODE'
    });

    assert.equal(result.success, false);
    assert.equal(result.message, 'Invalid MFA code');
    assert.equal(backupVerificationCalled, true);
    assert.equal(storedTokens.length, 0);
});

test('Fifth failed MFA attempt: reports the 15-minute lockout', async () => {
    totpValid = false;
    failedMfaAttempts = 4;

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '000000'
    });

    assert.equal(result.success, false);
    assert.match(result.message, /locked for 15 minutes/i);
    assert.equal(failedMfaAttempts, 5);
    assert.equal(storedTokens.length, 0);
});

test('MFA-locked user: rejects step-up authentication', async () => {
    fakeUser = createUser({
        mfa_locked_until: new Date(Date.now() + 15 * 60 * 1000)
    });

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('Admin-locked user: rejects step-up authentication', async () => {
    fakeUser = createUser({
        admin_locked: true
    });

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('User with inactive MFA: rejects step-up authentication', async () => {
    fakeUser = createUser({
        is_mfa_active: false
    });

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('Missing user: rejects step-up authentication', async () => {
    fakeUser = null;

    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('Invalid scope: rejects the request', async () => {
    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: 'INVALID_SCOPE',
        mfaCode: '123456'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('Both TOTP and backup code supplied: rejects the request', async () => {
    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        mfaCode: '123456',
        backupCode: 'TEST-BACKUP-CODE'
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});

test('Neither TOTP nor backup code supplied: rejects the request', async () => {
    const result = await authService.createStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE
    });

    assert.equal(result.success, false);
    assert.equal(storedTokens.length, 0);
});
