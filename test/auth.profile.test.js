
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { stubModule } = require('./helpers/testEnv');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

let fakeUser;
let auditLogs;
let passwordUpdateCalls;
let sessionRows;

const authModelMock = {
    findUserPasswordById: async userId =>
        userId === USER_ID ? { ...fakeUser } : null,

    findUserProfileById: async userId =>
        userId === USER_ID
            ? {
                user_id: fakeUser.user_id,
                email: fakeUser.email,
                role: fakeUser.role,
                hub_location_id: fakeUser.hub_location_id,
                created_at: fakeUser.created_at,
                is_mfa_active: fakeUser.is_mfa_active
            }
            : null,

    updatePasswordAndRevokeSessions: async (userId, passwordHash) => {
        passwordUpdateCalls.push({ userId, passwordHash });

        fakeUser.password_hash = passwordHash;

        return {
            user_id: userId,
            email: fakeUser.email
        };
    },

    listUserSessions: async userId =>
        userId === USER_ID ? sessionRows.map(row => ({ ...row })) : []
};

stubModule('config/db', {
    query: async () => ({ rows: [], rowCount: 0 })
});

stubModule('modules/auth/auth.model', authModelMock);

stubModule('modules/auth/audit.model', {
    createAuditLog: async data => {
        auditLogs.push(data);
        return { audit_id: 'test-audit-id' };
    }
});

stubModule('modules/auth/backupCode.model', {
    generateBackupCodesIfAbsent: async () => ({ created: false }),
    verifyAndConsumeBackupCode: async () => ({ success: false }),
    getBackupCodeStatus: async () => ({})
});

stubModule('modules/auth/mfaSecret', {
    encryptMfaSecret: () => 'test',
    createEncryptedMfaSecret: () => ({})
});

const authService = require('../src/modules/auth/auth.service');

const createUser = passwordHash => ({
    user_id: USER_ID,
    email: 'test@nsp.local',
    role: 'SUPER_ADMIN',
    hub_location_id: null,
    password_hash: passwordHash,
    created_at: new Date('2026-01-01T00:00:00Z'),
    is_mfa_active: true
});

beforeEach(async () => {
    const passwordHash = await bcrypt.hash('CurrentPassword123', 12);

    fakeUser = createUser(passwordHash);
    auditLogs = [];
    passwordUpdateCalls = [];

    sessionRows = [
        {
            session_id: SESSION_ID,
            ip_address: '127.0.0.1',
            device_fingerprint: 'test-device',
            expires_at: new Date(Date.now() + 60 * 60 * 1000),
            revoked: false,
            is_active: true
        },
        {
            session_id: '33333333-3333-4333-8333-333333333333',
            ip_address: '127.0.0.2',
            device_fingerprint: 'another-device',
            expires_at: new Date(Date.now() - 60 * 1000),
            revoked: true,
            is_active: false
        }
    ];
});

test('password change succeeds with the correct current password', async () => {
    const result = await authService.updateUserProfilePassword(
        USER_ID,
        'CurrentPassword123',
        'NewPassword456',
        '127.0.0.1'
    );

    assert.equal(result.success, true);
    assert.equal(passwordUpdateCalls.length, 1);

    const savedHash = passwordUpdateCalls[0].passwordHash;

    assert.notEqual(savedHash, 'NewPassword456');
    assert.equal(
        await bcrypt.compare('NewPassword456', savedHash),
        true
    );

    assert.equal(
        await bcrypt.compare('CurrentPassword123', savedHash),
        false
    );

    assert.ok(
        auditLogs.some(
            log => log.eventType === 'AUTH_PASSWORD_CHANGED'
        )
    );
});

test('password change rejects an incorrect current password', async () => {
    const result = await authService.updateUserProfilePassword(
        USER_ID,
        'WrongPassword123',
        'NewPassword456',
        '127.0.0.1'
    );

    assert.equal(result.success, false);
    assert.equal(result.message, 'Current password is incorrect');
    assert.equal(passwordUpdateCalls.length, 0);

    assert.ok(
        auditLogs.some(
            log => log.eventType === 'AUTH_PASSWORD_CHANGE_FAILED'
        )
    );
});

test('password change rejects the same current and new password', async () => {
    const result = await authService.updateUserProfilePassword(
        USER_ID,
        'CurrentPassword123',
        'CurrentPassword123',
        '127.0.0.1'
    );

    assert.equal(result.success, false);
    assert.equal(passwordUpdateCalls.length, 0);
});

test('password change rejects a nonexistent user', async () => {
    const result = await authService.updateUserProfilePassword(
        '99999999-9999-4999-8999-999999999999',
        'CurrentPassword123',
        'NewPassword456',
        '127.0.0.1'
    );

    assert.equal(result.success, false);
    assert.equal(result.message, 'User not found');
    assert.equal(passwordUpdateCalls.length, 0);
});

test('profile retrieval returns safe user information', async () => {
    const profile = await authService.getUserProfile(USER_ID);

    assert.equal(profile.user_id, USER_ID);
    assert.equal(profile.email, 'test@nsp.local');
    assert.equal(profile.role, 'SUPER_ADMIN');
    assert.equal(profile.is_mfa_active, true);

    assert.equal('password_hash' in profile, false);
    assert.equal('mfa_secret' in profile, false);
});

test('profile retrieval returns null for an unknown user', async () => {
    const profile = await authService.getUserProfile(
        '99999999-9999-4999-8999-999999999999'
    );

    assert.equal(profile, null);
});

test('session listing identifies the current session', async () => {
    const sessions = await authService.getUserSessions(
        USER_ID,
        SESSION_ID
    );

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].is_current, true);
    assert.equal(sessions[1].is_current, false);

    assert.equal('refresh_token_hash' in sessions[0], false);
    assert.equal('refresh_token_hash' in sessions[1], false);
});

test('session listing does not return another user sessions', async () => {
    const sessions = await authService.getUserSessions(
        '99999999-9999-4999-8999-999999999999',
        SESSION_ID
    );

    assert.deepEqual(sessions, []);
});
