
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { stubModule } = require('./helpers/testEnv');

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

const calls = {
    changeUserRole: [],
    reassignUserHub: [],
    setUserActiveStatus: [],
    resetUserPassword: [],
    getSecurityUserById: []
};

let modelMock;

const resetCalls = () => {
    Object.values(calls).forEach(items => {
        items.length = 0;
    });
};

modelMock = {
    changeUserRole: async (...args) => {
        calls.changeUserRole.push(args);
        return {
            previous: { role: 'TRADE_TESTER', hub_location_id: 1 },
            user: {
                user_id: TARGET_ID,
                role: args[1],
                hub_location_id: args[2]
            }
        };
    },

    reassignUserHub: async (...args) => {
        calls.reassignUserHub.push(args);
        return {
            user_id: TARGET_ID,
            role: 'TRADE_TESTER',
            hub_location_id: args[1]
        };
    },

    setUserActiveStatus: async (...args) => {
        calls.setUserActiveStatus.push(args);
        return {
            previous: { is_active: !args[1] },
            user: {
                user_id: TARGET_ID,
                is_active: args[1]
            }
        };
    },

    resetUserPassword: async (...args) => {
        calls.resetUserPassword.push(args);
        return {
            user_id: TARGET_ID,
            email: 'target@nsp.local'
        };
    },

    getSecurityUserById: async (...args) => {
        calls.getSecurityUserById.push(args);
        return {
            user_id: TARGET_ID,
            role: 'TRADE_TESTER',
            hub_location_id: 1
        };
    }
};

// Stub dependencies before importing the service.
stubModule('modules/superAdmin/superAdmin.model', modelMock);

stubModule('modules/auth/audit.model', {
    createAuditLog: async () => ({
        audit_id: 'test-audit-id'
    })
});

const superAdminService = require('../src/modules/superAdmin/superAdmin.service');

beforeEach(() => {
    resetCalls();
});

// --------------------------------------------------
// CHANGE USER ROLE
// --------------------------------------------------

test('B4: changes a user role successfully', async () => {
    const result = await superAdminService.changeUserRole({
        userId: TARGET_ID,
        role: 'CENTER_SUPERINTENDENT',
        hubLocationId: 2,
        adminUserId: ADMIN_ID,
        ipAddress: '127.0.0.1'
    });

    assert.equal(result.user.user_id, TARGET_ID);
    assert.equal(result.user.role, 'CENTER_SUPERINTENDENT');
    assert.equal(result.user.hub_location_id, 2);

    assert.equal(calls.changeUserRole.length, 1);
    assert.deepEqual(calls.changeUserRole[0], [
        TARGET_ID,
        'CENTER_SUPERINTENDENT',
        2,
        ADMIN_ID,
        '127.0.0.1'
    ]);
});

test('B4: rejects an unsupported role', async () => {
    await assert.rejects(
        superAdminService.changeUserRole({
            userId: TARGET_ID,
            role: 'UNKNOWN_ROLE',
            hubLocationId: 2,
            adminUserId: ADMIN_ID
        }),
        /Invalid user role/
    );

    assert.equal(calls.changeUserRole.length, 0);
});

test('B4: requires a valid hub for a hub-scoped role', async () => {
    await assert.rejects(
        superAdminService.changeUserRole({
            userId: TARGET_ID,
            role: 'TRADE_TESTER',
            hubLocationId: 6,
            adminUserId: ADMIN_ID
        }),
        /hubLocationId/
    );

    assert.equal(calls.changeUserRole.length, 0);
});

test('B4: allows SUPER_ADMIN role with a null hub', async () => {
    const result = await superAdminService.changeUserRole({
        userId: TARGET_ID,
        role: 'SUPER_ADMIN',
        hubLocationId: null,
        adminUserId: ADMIN_ID
    });

    assert.equal(result.user.role, 'SUPER_ADMIN');
    assert.equal(calls.changeUserRole[0][2], null);
});

test('B4: prevents an administrator from changing their own role', async () => {
    await assert.rejects(
        superAdminService.changeUserRole({
            userId: ADMIN_ID,
            role: 'TRADE_TESTER',
            hubLocationId: 1,
            adminUserId: ADMIN_ID
        }),
        error => error.statusCode === 403
    );

    assert.equal(calls.changeUserRole.length, 0);
});

// --------------------------------------------------
// REASSIGN USER HUB
// --------------------------------------------------

test('B4: reassigns a hub-scoped user successfully', async () => {
    const result = await superAdminService.reassignUserHub({
        userId: TARGET_ID,
        hubLocationId: 3,
        adminUserId: ADMIN_ID,
        ipAddress: '127.0.0.1'
    });

    assert.equal(result.user.user_id, TARGET_ID);
    assert.equal(result.user.hub_location_id, 3);

    assert.equal(calls.getSecurityUserById.length, 1);
    assert.equal(calls.reassignUserHub.length, 1);
});

test('B4: rejects an invalid hub ID', async () => {
    await assert.rejects(
        superAdminService.reassignUserHub({
            userId: TARGET_ID,
            hubLocationId: 0,
            adminUserId: ADMIN_ID
        }),
        /hubLocationId must be between 1 and 5/
    );

    assert.equal(calls.reassignUserHub.length, 0);
});

test('B4: rejects reassignment for a SUPER_ADMIN account', async () => {
    modelMock.getSecurityUserById = async () => ({
        user_id: TARGET_ID,
        role: 'SUPER_ADMIN',
        hub_location_id: null
    });

    await assert.rejects(
        superAdminService.reassignUserHub({
            userId: TARGET_ID,
            hubLocationId: 2,
            adminUserId: ADMIN_ID
        }),
        /Only hub-scoped users can be reassigned/
    );

    assert.equal(calls.reassignUserHub.length, 0);

    // Restore the default mock for subsequent tests.
    modelMock.getSecurityUserById = async (...args) => {
        calls.getSecurityUserById.push(args);
        return {
            user_id: TARGET_ID,
            role: 'TRADE_TESTER',
            hub_location_id: 1
        };
    };
});

// --------------------------------------------------
// ACCOUNT ACTIVATION STATUS
// --------------------------------------------------

test('B4: deactivates a user account', async () => {
    const result = await superAdminService.setUserActiveStatus({
        userId: TARGET_ID,
        isActive: false,
        adminUserId: ADMIN_ID,
        ipAddress: '127.0.0.1'
    });

    assert.equal(result.user.is_active, false);
    assert.equal(calls.setUserActiveStatus.length, 1);
});

test('B4: reactivates a user account', async () => {
    const result = await superAdminService.setUserActiveStatus({
        userId: TARGET_ID,
        isActive: true,
        adminUserId: ADMIN_ID
    });

    assert.equal(result.user.is_active, true);
    assert.equal(calls.setUserActiveStatus.length, 1);
});

test('B4: rejects a non-boolean account status', async () => {
    await assert.rejects(
        superAdminService.setUserActiveStatus({
            userId: TARGET_ID,
            isActive: 'false',
            adminUserId: ADMIN_ID
        }),
        /isActive must be a boolean/
    );

    assert.equal(calls.setUserActiveStatus.length, 0);
});

test('B4: prevents an administrator from deactivating their own account', async () => {
    await assert.rejects(
        superAdminService.setUserActiveStatus({
            userId: ADMIN_ID,
            isActive: false,
            adminUserId: ADMIN_ID
        }),
        error => error.statusCode === 403
    );

    assert.equal(calls.setUserActiveStatus.length, 0);
});

// --------------------------------------------------
// ADMIN PASSWORD RESET
// --------------------------------------------------

test('B4: resets another user password', async () => {
    const result = await superAdminService.resetUserPassword({
        userId: TARGET_ID,
        newPassword: 'NewSecurePassword123!',
        adminUserId: ADMIN_ID,
        ipAddress: '127.0.0.1'
    });

    assert.equal(result.user.user_id, TARGET_ID);
    assert.equal(calls.resetUserPassword.length, 1);

    assert.equal(
        calls.resetUserPassword[0][1],
        'NewSecurePassword123!'
    );
});

test('B4: rejects a password shorter than 12 bytes', async () => {
    await assert.rejects(
        superAdminService.resetUserPassword({
            userId: TARGET_ID,
            newPassword: 'Short123!',
            adminUserId: ADMIN_ID
        }),
        /12 and 72 bytes/
    );

    assert.equal(calls.resetUserPassword.length, 0);
});

test('B4: rejects a password longer than 72 bytes', async () => {
    await assert.rejects(
        superAdminService.resetUserPassword({
            userId: TARGET_ID,
            newPassword: 'A'.repeat(73),
            adminUserId: ADMIN_ID
        }),
        /12 and 72 bytes/
    );

    assert.equal(calls.resetUserPassword.length, 0);
});

test('B4: prevents an administrator from using admin reset on their own account', async () => {
    await assert.rejects(
        superAdminService.resetUserPassword({
            userId: ADMIN_ID,
            newPassword: 'NewSecurePassword123!',
            adminUserId: ADMIN_ID
        }),
        error => error.statusCode === 403
    );

    assert.equal(calls.resetUserPassword.length, 0);
});
