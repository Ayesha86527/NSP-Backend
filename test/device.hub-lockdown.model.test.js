
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

let model;
let queries;
let client;
let lockdownRows;
let failSessionsUpdate;

beforeEach(() => {
  queries = [];
  failSessionsUpdate = false;

  lockdownRows = [{
    hub_location_id: 2,
    is_locked: true,
    locked_by: 'admin-1'
  }];

  client = {
    query: async (sql, params = []) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();

      queries.push({
        sql: normalizedSql,
        params
      });

      if (normalizedSql === 'BEGIN') {
        return { rows: [] };
      }

      if (normalizedSql.includes('INSERT INTO auth.hub_device_lockdowns')) {
        return { rows: lockdownRows };
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

  delete require.cache[
    require.resolve('../src/modules/superAdmin/superAdmin.model')
  ];

  model = require('../src/modules/superAdmin/superAdmin.model');
});

test('setHubLockdown starts a transaction and enables lockdown', async () => {
  const result = await model.setHubLockdown(2, true, 'admin-1');

  assert.deepEqual(result, lockdownRows[0]);
  assert.equal(queries[0].sql, 'BEGIN');

  const lockdownUpdate = queries.find((entry) =>
    entry.sql.includes('INSERT INTO auth.hub_device_lockdowns')
  );

  assert.ok(lockdownUpdate);
  assert.deepEqual(lockdownUpdate.params, [2, true, 'admin-1']);

  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

test('setHubLockdown revokes active sessions for the selected hub', async () => {
  await model.setHubLockdown(2, true, 'admin-1');

  const sessionUpdate = queries.find((entry) =>
    entry.sql.includes('UPDATE auth.sessions')
  );

  assert.ok(sessionUpdate);
  assert.deepEqual(sessionUpdate.params, [2]);

  assert.match(sessionUpdate.sql, /u\.hub_location_id = \$1/);
  assert.match(sessionUpdate.sql, /s\.revoked = FALSE/);
  assert.match(sessionUpdate.sql, /u\.role <> 'SUPER_ADMIN'/);
});

test('setHubLockdown does not revoke sessions when unlocking', async () => {
  await model.setHubLockdown(2, false, 'admin-1');

  const sessionUpdate = queries.find((entry) =>
    entry.sql.includes('UPDATE auth.sessions')
  );

  assert.equal(sessionUpdate, undefined);
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(client.releaseCalled, true);
});

test('setHubLockdown commits only after session revocation succeeds', async () => {
  await model.setHubLockdown(2, true, 'admin-1');

  const sessionUpdateIndex = queries.findIndex((entry) =>
    entry.sql.includes('UPDATE auth.sessions')
  );

  const commitIndex = queries.findIndex((entry) =>
    entry.sql === 'COMMIT'
  );

  assert.ok(sessionUpdateIndex > 0);
  assert.ok(commitIndex > sessionUpdateIndex);
});

test('setHubLockdown rolls back when session revocation fails', async () => {
  failSessionsUpdate = true;

  await assert.rejects(
    model.setHubLockdown(2, true, 'admin-1'),
    /Session revocation failed/
  );

  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.equal(
    queries.some((entry) => entry.sql === 'COMMIT'),
    false
  );
  assert.equal(client.releaseCalled, true);
});

test('setHubLockdown commits when disabling lockdown', async () => {
  lockdownRows = [{
    hub_location_id: 2,
    is_locked: false,
    locked_by: 'admin-1'
  }];

  const result = await model.setHubLockdown(2, false, 'admin-1');

  assert.equal(result.is_locked, false);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});
