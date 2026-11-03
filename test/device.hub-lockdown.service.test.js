
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

let model;
let audit;
let service;
let lastModelCall;

beforeEach(() => {
  lastModelCall = null;

  model = {
    setHubLockdown: async (...args) => {
      lastModelCall = args;

      return {
        hub_location_id: args[0],
        is_locked: args[1],
        locked_by: args[2]
      };
    }
  };

  audit = {
    lastEntry: null,
    createAuditLog: async (entry) => {
      audit.lastEntry = entry;
      return {};
    }
  };

  stubModule('modules/superAdmin/superAdmin.model', model);
  stubModule('modules/auth/audit.model', audit);

  delete require.cache[
    require.resolve('../src/modules/superAdmin/superAdmin.service')
  ];

  service = require('../src/modules/superAdmin/superAdmin.service');
});

test('setHubLockdown enables lockdown and records the correct audit event', async () => {
  const result = await service.setHubLockdown({
    hubLocationId: 2,
    isLocked: true,
    adminUserId: 'admin-1',
    ipAddress: '127.0.0.1'
  });

  assert.deepEqual(lastModelCall, [2, true, 'admin-1']);

  assert.equal(result.message, 'Hub lockdown enabled');
  assert.equal(result.lockdown.is_locked, true);

  assert.equal(
    audit.lastEntry.eventType,
    'SUPER_ADMIN_HUB_LOCKDOWN_ENABLED'
  );

  assert.equal(audit.lastEntry.userId, 'admin-1');
  assert.equal(audit.lastEntry.ipAddress, '127.0.0.1');
  assert.equal(audit.lastEntry.details.hubLocationId, 2);
  assert.equal(audit.lastEntry.details.isLocked, true);
});

test('setHubLockdown disables lockdown and records the correct audit event', async () => {
  const result = await service.setHubLockdown({
    hubLocationId: 3,
    isLocked: false,
    adminUserId: 'admin-2'
  });

  assert.deepEqual(lastModelCall, [3, false, 'admin-2']);

  assert.equal(result.message, 'Hub lockdown disabled');
  assert.equal(result.lockdown.is_locked, false);

  assert.equal(
    audit.lastEntry.eventType,
    'SUPER_ADMIN_HUB_LOCKDOWN_DISABLED'
  );

  assert.equal(audit.lastEntry.userId, 'admin-2');
  assert.equal(audit.lastEntry.details.hubLocationId, 3);
  assert.equal(audit.lastEntry.details.isLocked, false);
});

test('setHubLockdown accepts a numeric string hub ID', async () => {
  await service.setHubLockdown({
    hubLocationId: '4',
    isLocked: true,
    adminUserId: 'admin-1'
  });

  assert.deepEqual(lastModelCall, [4, true, 'admin-1']);
});

test('setHubLockdown rejects a hub ID below 1', async () => {
  await assert.rejects(
    service.setHubLockdown({
      hubLocationId: 0,
      isLocked: true,
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );

  assert.equal(lastModelCall, null);
});

test('setHubLockdown rejects a hub ID above 5', async () => {
  await assert.rejects(
    service.setHubLockdown({
      hubLocationId: 6,
      isLocked: true,
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );

  assert.equal(lastModelCall, null);
});

test('setHubLockdown rejects a non-integer hub ID', async () => {
  await assert.rejects(
    service.setHubLockdown({
      hubLocationId: 2.5,
      isLocked: true,
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );

  assert.equal(lastModelCall, null);
});

test('setHubLockdown rejects a non-boolean isLocked value', async () => {
  await assert.rejects(
    service.setHubLockdown({
      hubLocationId: 2,
      isLocked: 'true',
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );

  assert.equal(lastModelCall, null);
});
