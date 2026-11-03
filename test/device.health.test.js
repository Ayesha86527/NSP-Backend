
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

let model;
let audit;
let service;

const createDevice = (overrides = {}) => ({
  device_id: 'device-123',
  hub_location_id: 2,
  device_name: 'Hub Laptop',
  device_fingerprint: 'fingerprint-abc',
  edr_status: 'compliant',
  revoked: false,
  last_heartbeat_at: new Date(Date.now() - 60 * 1000),
  ...overrides
});

beforeEach(() => {
  process.env.DEVICE_ONLINE_THRESHOLD_SECONDS = '300';

  model = {
    getDeviceHealth: async () => []
  };

  audit = {
    createAuditLog: async () => ({})
  };

  stubModule('modules/superAdmin/superAdmin.model', model);
  stubModule('modules/auth/audit.model', audit);

  delete require.cache[
    require.resolve('../src/modules/superAdmin/superAdmin.service')
  ];

  service = require('../src/modules/superAdmin/superAdmin.service');
});

test('getDeviceHealth marks a device online when heartbeat is recent', async () => {
  model.getDeviceHealth = async () => [
    createDevice({
      last_heartbeat_at: new Date(Date.now() - 60 * 1000)
    })
  ];

  const devices = await service.getDeviceHealth(2);

  assert.equal(devices.length, 1);
  assert.equal(devices[0].status, 'online');
});

test('getDeviceHealth marks a device offline when heartbeat exceeds 300 seconds', async () => {
  model.getDeviceHealth = async () => [
    createDevice({
      last_heartbeat_at: new Date(Date.now() - 301 * 1000)
    })
  ];

  const devices = await service.getDeviceHealth(2);

  assert.equal(devices[0].status, 'offline');
});

test('getDeviceHealth marks a device offline when heartbeat is missing', async () => {
  model.getDeviceHealth = async () => [
    createDevice({
      last_heartbeat_at: null
    })
  ];

  const devices = await service.getDeviceHealth(2);

  assert.equal(devices[0].status, 'offline');
});

test('getDeviceHealth marks a revoked device offline even with a recent heartbeat', async () => {
  model.getDeviceHealth = async () => [
    createDevice({
      revoked: true,
      last_heartbeat_at: new Date()
    })
  ];

  const devices = await service.getDeviceHealth(2);

  assert.equal(devices[0].status, 'offline');
});

test('getDeviceHealth marks a device online at exactly the 300-second threshold', async () => {
  model.getDeviceHealth = async () => [
    createDevice({
      last_heartbeat_at: new Date(Date.now() - 300 * 1000)
    })
  ];

  const devices = await service.getDeviceHealth(2);

  assert.equal(devices[0].status, 'online');
});

test('getDeviceHealth passes the hub location filter to the model', async () => {
  let receivedHubId;

  model.getDeviceHealth = async (hubId) => {
    receivedHubId = hubId;
    return [];
  };

  await service.getDeviceHealth('3');

  assert.equal(receivedHubId, 3);
});

test('getDeviceHealth retrieves devices from all hubs when no hub is supplied', async () => {
  let receivedHubId = 'not-called';

  model.getDeviceHealth = async (hubId) => {
    receivedHubId = hubId;
    return [];
  };

  await service.getDeviceHealth();

  assert.equal(receivedHubId, null);
});

test('getDeviceHealth rejects an invalid hub location', async () => {
  await assert.rejects(
    service.getDeviceHealth(6),
    (error) => error.statusCode === 400
  );
});
