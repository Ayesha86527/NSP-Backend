
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');
const crypto = require('node:crypto');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

let fakeUser;
let currentSession;
let tokenHistory;
let revokedSessions;
let auditLogs;
let rotationResult;

const fakePool = {
    query: async (sql) => {
        if (sql.includes('FROM auth.users')) {
            return {
                rows: fakeUser ? [{ ...fakeUser }] : [],
                rowCount: fakeUser ? 1 : 0
            };
        }

        throw new Error(`Unexpected database query: ${sql}`);
    }
};

const authModelMock = {
    findSessionByRefreshTokenHash: async hash =>
        currentSession &&
        currentSession.refresh_token_hash === hash
            ? { ...currentSession }
            : null,

    findRefreshTokenHistory: async hash =>
        tokenHistory.get(hash) || null,

    revokeSession: async () => {},

    revokeSessionFamily: async sessionId => {
        revokedSessions.push(sessionId);
        if (currentSession?.session_id === sessionId) {
            currentSession.revoked = true;
        }
    },

    rotateRefreshToken: async (
        sessionId,
        oldHash,
        newHash,
        expiresAt,
        ipAddress,
        deviceFingerprint
    ) => {
        if (
            !rotationResult ||
            !currentSession ||
            currentSession.session_id !== sessionId ||
            currentSession.refresh_token_hash !== oldHash ||
            currentSession.revoked
        ) {
            return null;
        }

        currentSession.refresh_token_hash = newHash;
        currentSession.expires_at = expiresAt;
        currentSession.ip_address = ipAddress;
        currentSession.device_fingerprint =
            currentSession.device_fingerprint || deviceFingerprint;

        tokenHistory.set(oldHash, {
            session_id: sessionId,
            user_id: USER_ID
        });

        return { ...currentSession };
    },

    findUserByEmail: async () => null,
    findUserForMfa: async () => null,
    findUserById: async () => null,
    recordFailedLogin: async () => null,
    resetFailedLoginAttempts: async () => {},
    recordFailedMfa: async () => null,
    resetFailedMfa: async () => {}
};

const auditModelMock = {
    createAuditLog: async data => {
        auditLogs.push(data);
        return { audit_id: 'test-audit-id' };
    }
};

stubModule('config/db', fakePool);
stubModule('modules/auth/auth.model', authModelMock);
stubModule('modules/auth/audit.model', auditModelMock);
stubModule('modules/auth/backupCode.model', {
    generateBackupCodesIfAbsent: async () => ({ created: false }),
    verifyAndConsumeBackupCode: async () => ({ success: false }),
    getBackupCodeStatus: async () => ({})
});
stubModule('modules/auth/mfaSecret', {
    encryptMfaSecret: () => 'test',
    createEncryptedMfaSecret: () => ({})
});

let authService;

try {
    authService = require('../src/modules/auth/auth.service');
} catch (error) {
    throw error;
}

const createUser = () => ({
    user_id: USER_ID,
    email: 'test@nsp.local',
    role: 'SUPER_ADMIN',
    hub_location_id: null,
    password_hash: 'test-hash',
    is_mfa_active: true,
    mfa_enrollment_pending: false,
    admin_locked: false,
    token_version: 0,
    failed_login_attempts: 0,
    locked_until: null,
    failed_mfa_attempts: 0,
    mfa_locked_until: null
});

const createSession = token => ({
    session_id: SESSION_ID,
    user_id: USER_ID,
    refresh_token_hash: crypto
        .createHash('sha256')
        .update(token)
        .digest('hex'),
    ip_address: '127.0.0.1',
    device_fingerprint: null,
    expires_at: new Date(Date.now() + 60 * 60 * 1000),
    revoked: false
});

beforeEach(() => {
    fakeUser = createUser();
    currentSession = null;
    tokenHistory = new Map();
    revokedSessions = [];
    auditLogs = [];
    rotationResult = true;
});

test('valid refresh token rotates successfully', async () => {
    const oldToken = 'valid-refresh-token';
    currentSession = createSession(oldToken);

    const result = await authService.refreshAccessToken(
        oldToken,
        '127.0.0.1'
    );

    assert.equal(result.success, true);
    assert.ok(result.accessToken);
    assert.ok(result.refreshToken);
    assert.notEqual(result.refreshToken, oldToken);
    assert.equal(revokedSessions.length, 0);

    assert.ok(
        auditLogs.some(log => log.eventType === 'AUTH_TOKEN_REFRESHED')
    );
});

test('previously rotated token revokes its session family', async () => {
    const oldToken = 'previously-rotated-token';
    const oldHash = crypto
        .createHash('sha256')
        .update(oldToken)
        .digest('hex');

    tokenHistory.set(oldHash, {
        session_id: SESSION_ID,
        user_id: USER_ID
    });

    currentSession = createSession('current-refresh-token');

    const resultPromise = authService.refreshAccessToken(oldToken);

    await assert.rejects(
        resultPromise,
        /Invalid or expired refresh token/
    );

    assert.deepEqual(revokedSessions, [SESSION_ID]);

    assert.ok(
        auditLogs.some(
            log =>
                log.eventType === 'AUTH_REFRESH_TOKEN_REUSE_DETECTED'
        )
    );
});

test('random invalid token does not revoke any session', async () => {
    currentSession = createSession('current-refresh-token');

    await assert.rejects(
        authService.refreshAccessToken('random-invalid-token'),
        /Invalid or expired refresh token/
    );

    assert.equal(revokedSessions.length, 0);

    assert.equal(
        auditLogs.some(
            log =>
                log.eventType === 'AUTH_REFRESH_TOKEN_REUSE_DETECTED'
        ),
        false
    );
});

test('concurrent rotation failure detects reuse and revokes session', async () => {
    const oldToken = 'concurrent-refresh-token';
    const oldHash = crypto
        .createHash('sha256')
        .update(oldToken)
        .digest('hex');

    currentSession = createSession(oldToken);
    rotationResult = false;

    tokenHistory.set(oldHash, {
        session_id: SESSION_ID,
        user_id: USER_ID
    });

    await assert.rejects(
        authService.refreshAccessToken(oldToken),
        /Invalid or expired refresh token/
    );

    assert.deepEqual(revokedSessions, [SESSION_ID]);

    assert.ok(
        auditLogs.some(
            log =>
                log.eventType === 'AUTH_REFRESH_TOKEN_REUSE_DETECTED'
        )
    );
});
