
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

let model;
let audit;
let service;
let modelCalls;

const device = {
  device_id: '123e4567-e89b-12d3-a456-426614174000',
  hub_location_id: 2,
  device_name: 'Hub Laptop',
  device_fingerprint: 'fingerprint-abc'
};

beforeEach(() => {
  modelCalls = {
    list: [],
    revoke: []
  };

  model = {
    listAuthorizedDevices: async (filters) => {
      modelCalls.list.push(filters);
      return [device];
    },

    revokeAuthorizedDevice: async (deviceId) => {
      modelCalls.revoke.push(deviceId);
      return { ...device };
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

test('listDevices uses default pagination and no hub filter', async () => {
  const result = await service.listDevices();

  assert.deepEqual(result, [device]);

  assert.deepEqual(modelCalls.list[0], {
    hubLocationId: null,
    limit: 50,
    offset: 0
  });
});

test('listDevices applies custom pagination and hub filter', async () => {
  await service.listDevices({
    hubLocationId: '3',
    limit: '20',
    offset: '10'
  });

  assert.deepEqual(modelCalls.list[0], {
    hubLocationId: 3,
    limit: 20,
    offset: 10
  });
});

test('listDevices caps the maximum limit at 100', async () => {
  await service.listDevices({
    limit: 500,
    offset: 0
  });

  assert.equal(modelCalls.list[0].limit, 100);
});

test('listDevices does not allow a limit below 1', async () => {
  await service.listDevices({
    limit: 0
  });

  assert.equal(modelCalls.list[0].limit, 50);
});

test('listDevices rejects an invalid hub location', async () => {
  await assert.rejects(
    service.listDevices({ hubLocationId: 6 }),
    /hubLocationId must be between 1 and 5/
  );

  assert.equal(modelCalls.list.length, 0);
});

test('listDevices prevents negative offsets', async () => {
  await service.listDevices({
    limit: 10,
    offset: -5
  });

  assert.equal(modelCalls.list[0].offset, 0);
});

test('revokeDevice rejects an invalid UUID', async () => {
  await assert.rejects(
    service.revokeDevice({
      deviceId: 'invalid-id',
      adminUserId: 'admin-1',
      ipAddress: '127.0.0.1'
    }),
    /Invalid device ID format/
  );

  assert.equal(modelCalls.revoke.length, 0);
});

test('revokeDevice returns 404 when the active device is not found', async () => {
  model.revokeAuthorizedDevice = async () => null;

  await assert.rejects(
    service.revokeDevice({
      deviceId: device.device_id,
      adminUserId: 'admin-1',
      ipAddress: '127.0.0.1'
    }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /Active device not found/);
      return true;
    }
  );
});

test('revokeDevice revokes the device and records an audit event', async () => {
  const result = await service.revokeDevice({
    deviceId: device.device_id,
    adminUserId: 'admin-1',
    ipAddress: '127.0.0.1'
  });

  assert.equal(modelCalls.revoke.length, 1);
  assert.equal(modelCalls.revoke[0], device.device_id);

  assert.equal(
    result.message,
    'Device revoked and associated sessions invalidated'
  );

  assert.deepEqual(result.device, device);

  assert.ok(audit.lastEntry);
  assert.equal(
    audit.lastEntry.eventType,
    'SUPER_ADMIN_DEVICE_REVOKED'
  );
  assert.equal(audit.lastEntry.userId, 'admin-1');
  assert.equal(audit.lastEntry.ipAddress, '127.0.0.1');

  assert.deepEqual(audit.lastEntry.details, {
    deviceId: device.device_id,
    hubLocationId: 2,
    deviceName: 'Hub Laptop'
  });
});
