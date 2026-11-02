
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule } = require('./helpers/testEnv');

let model;
let audit;
let service;

const registeredDevice = {
  device_id: 'device-123',
  hub_location_id: 2,
  device_name: 'Hub Laptop',
  device_fingerprint: 'fingerprint-abc',
  edr_status: 'unknown',
  revoked: false
};

beforeEach(() => {
  model = {
    registerAuthorizedDevice: async () => ({ ...registeredDevice })
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

test('registerDevice validates hub location', async () => {
  await assert.rejects(
    service.registerDevice({
      hubLocationId: 6,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc',
      deviceCredentialHash: 'a'.repeat(64),
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );
});

test('registerDevice rejects an empty device name', async () => {
  await assert.rejects(
    service.registerDevice({
      hubLocationId: 2,
      deviceName: '  ',
      deviceFingerprint: 'fingerprint-abc',
      deviceCredentialHash: 'a'.repeat(64),
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );
});

test('registerDevice rejects an empty fingerprint', async () => {
  await assert.rejects(
    service.registerDevice({
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: '  ',
      deviceCredentialHash: 'a'.repeat(64),
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );
});

test('registerDevice rejects an invalid credential hash', async () => {
  await assert.rejects(
    service.registerDevice({
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc',
      deviceCredentialHash: 'not-a-sha256-hash',
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 400
  );
});

test('registerDevice trims the name and normalizes the fingerprint', async () => {
  let received;

  model.registerAuthorizedDevice = async (data) => {
    received = data;
    return { ...registeredDevice };
  };

  const result = await service.registerDevice({
    hubLocationId: '2',
    deviceName: '  Hub Laptop  ',
    deviceFingerprint: '  FingerPrint-ABC  ',
    deviceCredentialHash: 'a'.repeat(64),
    adminUserId: 'admin-1',
    ipAddress: '127.0.0.1'
  });

  assert.equal(received.hubLocationId, 2);
  assert.equal(received.deviceName, 'Hub Laptop');
  assert.equal(received.deviceFingerprint, 'fingerprint-abc');
  assert.equal(received.deviceCredentialHash, 'a'.repeat(64));
  assert.equal(result.message, 'Device registered successfully');
});

test('registerDevice records an audit event without including the credential hash', async () => {
  await service.registerDevice({
    hubLocationId: 2,
    deviceName: 'Hub Laptop',
    deviceFingerprint: 'fingerprint-abc',
    deviceCredentialHash: 'b'.repeat(64),
    adminUserId: 'admin-1',
    ipAddress: '127.0.0.1'
  });

  const auditEntry = audit.lastEntry;

  assert.ok(auditEntry, 'Audit event should be recorded');
  assert.equal(auditEntry.userId, 'admin-1');
  assert.equal(auditEntry.eventType, 'SUPER_ADMIN_DEVICE_REGISTERED');
  assert.equal(auditEntry.ipAddress, '127.0.0.1');
  assert.equal(auditEntry.details.deviceId, 'device-123');
  assert.equal(auditEntry.details.deviceName, 'Hub Laptop');

  assert.equal(
    JSON.stringify(auditEntry).includes('b'.repeat(64)),
    false
  );
});

test('registerDevice converts duplicate database errors into HTTP 409', async () => {
  model.registerAuthorizedDevice = async () => {
    const error = new Error('Duplicate device');
    error.code = '23505';
    throw error;
  };

  await assert.rejects(
    service.registerDevice({
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc',
      deviceCredentialHash: 'a'.repeat(64),
      adminUserId: 'admin-1'
    }),
    (error) => error.statusCode === 409
  );
});
