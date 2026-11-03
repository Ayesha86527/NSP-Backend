
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

const DEVICE_ID = '123e4567-e89b-12d3-a456-426614174000';

const device = {
  device_id: DEVICE_ID,
  hub_location_id: 2,
  device_name: 'Hub Laptop',
  device_fingerprint: 'fingerprint-abc'
};

let model;
let queries;
let client;
let deviceRows;
let failSessionsUpdate;

beforeEach(() => {
  queries = [];
  deviceRows = [{ ...device }];
  failSessionsUpdate = false;

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

      if (normalizedSql.includes('UPDATE auth.authorized_devices')) {
        return { rows: deviceRows };
      }

      if (normalizedSql.includes('UPDATE auth.sessions')) {
        if (failSessionsUpdate) {
          throw new Error('Session revocation failed');
        }

        return { rows: [] };
      }

      if (normalizedSql === 'COMMIT' || normalizedSql === 'ROLLBACK') {
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

test('revokeAuthorizedDevice starts a transaction and revokes the device', async () => {
  const result = await model.revokeAuthorizedDevice(DEVICE_ID);

  assert.deepEqual(result, device);

  assert.equal(queries[0].sql, 'BEGIN');

  const deviceUpdate = queries.find((entry) =>
    entry.sql.includes('UPDATE auth.authorized_devices')
  );

  assert.ok(deviceUpdate);
  assert.deepEqual(deviceUpdate.params, [DEVICE_ID]);

  assert.match(deviceUpdate.sql, /revoked = TRUE/);
  assert.match(deviceUpdate.sql, /revoked_at = COALESCE/);
  assert.match(deviceUpdate.sql, /AND revoked = FALSE/);

  assert.equal(
    queries.at(-1).sql,
    'COMMIT'
  );

  assert.equal(client.releaseCalled, true);
});

test('revokeAuthorizedDevice revokes associated sessions using hub and fingerprint', async () => {
  await model.revokeAuthorizedDevice(DEVICE_ID);

  const sessionUpdate = queries.find((entry) =>
    entry.sql.includes('UPDATE auth.sessions')
  );

  assert.ok(sessionUpdate);

  assert.deepEqual(sessionUpdate.params, [
    device.hub_location_id,
    device.device_fingerprint
  ]);

  assert.match(sessionUpdate.sql, /SET revoked = TRUE/);
  assert.match(sessionUpdate.sql, /s\.device_fingerprint = \$2/);
  assert.match(sessionUpdate.sql, /u\.hub_location_id = \$1/);
  assert.match(sessionUpdate.sql, /s\.revoked = FALSE/);
});

test('revokeAuthorizedDevice commits only after device and session updates succeed', async () => {
  await model.revokeAuthorizedDevice(DEVICE_ID);

  const sqlStatements = queries.map((entry) => entry.sql);

  const beginIndex = sqlStatements.indexOf('BEGIN');
  const deviceIndex = sqlStatements.findIndex((sql) =>
    sql.includes('UPDATE auth.authorized_devices')
  );
  const sessionsIndex = sqlStatements.findIndex((sql) =>
    sql.includes('UPDATE auth.sessions')
  );
  const commitIndex = sqlStatements.indexOf('COMMIT');

  assert.ok(beginIndex < deviceIndex);
  assert.ok(deviceIndex < sessionsIndex);
  assert.ok(sessionsIndex < commitIndex);
});

test('revokeAuthorizedDevice rolls back when the device is not found', async () => {
  deviceRows = [];

  const result = await model.revokeAuthorizedDevice(DEVICE_ID);

  assert.equal(result, null);

  const sqlStatements = queries.map((entry) => entry.sql);

  assert.ok(sqlStatements.includes('BEGIN'));
  assert.ok(sqlStatements.includes('ROLLBACK'));
  assert.equal(sqlStatements.includes('COMMIT'), false);

  assert.equal(
    queries.some((entry) =>
      entry.sql.includes('UPDATE auth.sessions')
    ),
    false
  );

  assert.equal(client.releaseCalled, true);
});

test('revokeAuthorizedDevice rolls back when session revocation fails', async () => {
  failSessionsUpdate = true;

  await assert.rejects(
    model.revokeAuthorizedDevice(DEVICE_ID),
    /Session revocation failed/
  );

  const sqlStatements = queries.map((entry) => entry.sql);

  assert.ok(sqlStatements.includes('BEGIN'));
  assert.ok(sqlStatements.some((sql) =>
    sql.includes('UPDATE auth.authorized_devices')
  ));
  assert.ok(sqlStatements.some((sql) =>
    sql.includes('UPDATE auth.sessions')
  ));
  assert.ok(sqlStatements.includes('ROLLBACK'));

  assert.equal(sqlStatements.includes('COMMIT'), false);
  assert.equal(client.releaseCalled, true);
});
