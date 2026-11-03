const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

let model;
let queries;
let client;
let targetUser;
let updatedUser;
let activeAdminCount;
let failSessionsUpdate;
let failAuditInsert;
let auditEntries;

beforeEach(() => {
  queries = [];
  failSessionsUpdate = false;
  failAuditInsert = false;
  auditEntries = [];

  targetUser = {
    user_id: TARGET_ID,
    email: 'target@nsp.local',
    role: 'TRADE_TESTER',
    hub_location_id: 1,
    is_active: true,
    token_version: 0
  };

  updatedUser = null;
  activeAdminCount = 2;

  client = {
    query: async (sql, params = []) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      queries.push({ sql: normalizedSql, params });

      if (normalizedSql === 'BEGIN') {
        return { rows: [] };
      }

      if (normalizedSql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }

      if (
        normalizedSql.includes('SELECT') &&
        normalizedSql.includes('FROM auth.users') &&
        normalizedSql.includes('FOR UPDATE')
      ) {
        return {
          rows: targetUser ? [{ ...targetUser }] : []
        };
      }

      if (
        normalizedSql.includes('COUNT(*)') &&
        normalizedSql.includes('SUPER_ADMIN')
      ) {
        return {
          rows: [{ total: activeAdminCount }]
        };
      }

      if (normalizedSql.includes('UPDATE auth.users')) {
        if (!targetUser) {
          return { rows: [] };
        }

        updatedUser = { ...targetUser };

        if (normalizedSql.includes('SET role')) {
          updatedUser.role = params[1];
          updatedUser.hub_location_id = params[2];
        }

        if (normalizedSql.includes('hub_location_id = $2')) {
          updatedUser.hub_location_id = params[1];
        }

        if (normalizedSql.includes('is_active = $2')) {
          updatedUser.is_active = params[1];
        }

        if (normalizedSql.includes('password_hash')) {
          updatedUser.password_hash = params[0];
        }

        updatedUser.token_version += 1;

        return { rows: [{ ...updatedUser }] };
      }

      if (normalizedSql.includes('UPDATE auth.sessions')) {
        if (failSessionsUpdate) {
          throw new Error('Session revocation failed');
        }

        return { rows: [] };
      }

      if (
        normalizedSql === 'COMMIT' ||
        normalizedSql === 'ROLLBACK'
      ) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL query: ${normalizedSql}`);
    },

    releaseCalled: false,

    release() {
      this.releaseCalled = true;
    }
  };

  const pool = {
    connect: async () => client
  };

  stubModule('config/db', pool);

  stubModule('modules/auth/audit.model', {
    createAuditLog: async (data) => {
      auditEntries.push(data);

      if (failAuditInsert) {
        throw new Error('Audit insert failed');
      }

      return { audit_id: 'test-audit-id' };
    }
  });

  delete require.cache[
    require.resolve('../src/modules/superAdmin/superAdmin.model')
  ];

  model = require('../src/modules/superAdmin/superAdmin.model');
});

// --------------------------------------------------
// CHANGE USER ROLE
// --------------------------------------------------

test('B4 model: changes role, revokes sessions and audits transactionally', async () => {
  const result = await model.changeUserRole(
    TARGET_ID,
    'CENTER_SUPERINTENDENT',
    2,
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result.user.role, 'CENTER_SUPERINTENDENT');
  assert.equal(result.user.hub_location_id, 2);

  assert.ok(queries.some(q => q.sql === 'BEGIN'));
  assert.ok(queries.some(q => q.sql.includes('UPDATE auth.sessions')));

  assert.equal(
    auditEntries[0].eventType,
    'SUPER_ADMIN_USER_ROLE_CHANGED'
  );

  assert.equal(auditEntries[0].client, client);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

test('B4 model: prevents demotion of the last active Super Admin', async () => {
  targetUser.role = 'SUPER_ADMIN';
  activeAdminCount = 1;

  await assert.rejects(
    model.changeUserRole(
      TARGET_ID,
      'TRADE_TESTER',
      2,
      ADMIN_ID,
      '127.0.0.1'
    ),
    /last active Super Admin/i
  );

  assert.equal(queries.at(-1).sql, 'ROLLBACK');

  assert.equal(
    queries.some(q => q.sql.includes('UPDATE auth.users')),
    false
  );

  assert.equal(client.releaseCalled, true);
});

// --------------------------------------------------
// REASSIGN USER HUB
// --------------------------------------------------

test('B4 model: reassigns hub and records audit in the transaction', async () => {
  const result = await model.reassignUserHub(
    TARGET_ID,
    3,
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result.hub_location_id, 3);

  assert.ok(
    queries.some(q => q.sql.includes('UPDATE auth.sessions'))
  );

  assert.equal(
    auditEntries[0].eventType,
    'SUPER_ADMIN_USER_HUB_REASSIGNED'
  );

  assert.equal(auditEntries[0].client, client);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

test('B4 model: returns null when the hub target does not exist', async () => {
  targetUser = null;

  const result = await model.reassignUserHub(
    TARGET_ID,
    3,
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result, null);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(client.releaseCalled, true);
});

// --------------------------------------------------
// ACCOUNT STATUS
// --------------------------------------------------

test('B4 model: deactivates account and protects last active Super Admin', async () => {
  const result = await model.setUserActiveStatus(
    TARGET_ID,
    false,
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result.user.is_active, false);

  assert.ok(
    queries.some(q => q.sql.includes('UPDATE auth.sessions'))
  );

  assert.equal(
    auditEntries[0].eventType,
    'SUPER_ADMIN_USER_DEACTIVATED'
  );

  assert.equal(auditEntries[0].client, client);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

test('B4 model: prevents deactivation of the last active Super Admin', async () => {
  targetUser.role = 'SUPER_ADMIN';
  activeAdminCount = 1;

  await assert.rejects(
    model.setUserActiveStatus(
      TARGET_ID,
      false,
      ADMIN_ID,
      '127.0.0.1'
    ),
    /last active Super Admin/i
  );

  assert.equal(queries.at(-1).sql, 'ROLLBACK');

  assert.equal(
    queries.some(q => q.sql.includes('UPDATE auth.users')),
    false
  );

  assert.equal(client.releaseCalled, true);
});

test('B4 model: reactivates account with a reactivation audit event', async () => {
  targetUser.is_active = false;

  const result = await model.setUserActiveStatus(
    TARGET_ID,
    true,
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result.user.is_active, true);
  assert.equal(
    auditEntries[0].eventType,
    'SUPER_ADMIN_USER_REACTIVATED'
  );

  assert.equal(queries.at(-1).sql, 'COMMIT');
});

// --------------------------------------------------
// PASSWORD RESET
// --------------------------------------------------

test('B4 model: resets password, revokes sessions and audits the action', async () => {
  const result = await model.resetUserPassword(
    TARGET_ID,
    'NewSecurePassword123!',
    ADMIN_ID,
    '127.0.0.1'
  );

  assert.equal(result.user_id, TARGET_ID);
  assert.ok(result.password_hash);

  assert.ok(
    queries.some(q => q.sql.includes('UPDATE auth.sessions'))
  );

  assert.equal(
    auditEntries[0].eventType,
    'SUPER_ADMIN_USER_PASSWORD_RESET'
  );

  assert.equal(auditEntries[0].client, client);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

// --------------------------------------------------
// TRANSACTION ROLLBACK
// --------------------------------------------------

test('B4 model: rolls back role change if session revocation fails', async () => {
  failSessionsUpdate = true;

  await assert.rejects(
    model.changeUserRole(
      TARGET_ID,
      'CENTER_SUPERINTENDENT',
      2,
      ADMIN_ID,
      '127.0.0.1'
    ),
    /Session revocation failed/
  );

  assert.equal(queries.at(-1).sql, 'ROLLBACK');

  assert.equal(
    queries.some(q => q.sql === 'COMMIT'),
    false
  );

  assert.equal(client.releaseCalled, true);
});

test('B4 model: rolls back account change if audit insertion fails', async () => {
  failAuditInsert = true;

  await assert.rejects(
    model.setUserActiveStatus(
      TARGET_ID,
      false,
      ADMIN_ID,
      '127.0.0.1'
    ),
    /Audit insert failed/
  );

  assert.equal(queries.at(-1).sql, 'ROLLBACK');

  assert.equal(
    queries.some(q => q.sql === 'COMMIT'),
    false
  );

  assert.equal(client.releaseCalled, true);
});