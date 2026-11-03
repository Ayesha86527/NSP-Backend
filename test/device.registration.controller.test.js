
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stubModule } = require('./helpers/testEnv');

let service;
let controller;
let receivedInput;

const registeredData = {
  message: 'Device registered successfully',
  device: {
    device_id: 'device-123',
    hub_location_id: 2,
    device_name: 'Hub Laptop',
    device_fingerprint: 'fingerprint-abc',
    edr_status: 'unknown',
    revoked: false
  }
};

beforeEach(() => {
  receivedInput = null;

  service = {
    registerDevice: async (input) => {
      receivedInput = input;
      return registeredData;
    }
  };

  stubModule('modules/superAdmin/superAdmin.service', service);

  delete require.cache[
    require.resolve('../src/modules/superAdmin/superAdmin.controller')
  ];

  controller = require('../src/modules/superAdmin/superAdmin.controller');
});

const createResponse = () => {
  const res = {
    statusCode: null,
    body: null,

    status(code) {
      this.statusCode = code;
      return this;
    },

    json(data) {
      this.body = data;
      return this;
    }
  };

  return res;
};

test('registerDevice generates a 64-character hexadecimal credential', async () => {
  const req = {
    body: {
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc'
    },
    user: { userId: 'admin-1' },
    ip: '127.0.0.1'
  };

  const res = createResponse();

  await controller.registerDevice(req, res, (error) => {
    throw error;
  });

  const credential = res.body.data.deviceCredential;

  assert.equal(typeof credential, 'string');
  assert.equal(credential.length, 64);
  assert.match(credential, /^[a-f0-9]{64}$/);
});

test('registerDevice passes the SHA-256 hash to the service, not the plaintext credential', async () => {
  const req = {
    body: {
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc'
    },
    user: { userId: 'admin-1' },
    ip: '127.0.0.1'
  };

  const res = createResponse();

  await controller.registerDevice(req, res, (error) => {
    throw error;
  });

  const credential = res.body.data.deviceCredential;

  const expectedHash = crypto
    .createHash('sha256')
    .update(credential)
    .digest('hex');

  assert.equal(receivedInput.deviceCredentialHash, expectedHash);
  assert.equal(
    Object.hasOwn(receivedInput, 'deviceCredential'),
    false
  );
});

test('registerDevice returns the plaintext credential only in the registration response', async () => {
  const req = {
    body: {
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc'
    },
    user: { userId: 'admin-1' },
    ip: '127.0.0.1'
  };

  const res = createResponse();

  await controller.registerDevice(req, res, (error) => {
    throw error;
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);

  const credential = res.body.data.deviceCredential;

  assert.ok(credential);
  assert.equal(
    Object.hasOwn(res.body.data, 'deviceCredentialHash'),
    false
  );

  assert.equal(
    JSON.stringify(receivedInput).includes(credential),
    false
  );
});

test('registerDevice passes the admin and request details to the service', async () => {
  const req = {
    body: {
      hubLocationId: 3,
      deviceName: 'Superintendent Laptop',
      deviceFingerprint: 'fingerprint-xyz'
    },
    user: { userId: 'admin-42' },
    ip: '192.168.1.10'
  };

  const res = createResponse();

  await controller.registerDevice(req, res, (error) => {
    throw error;
  });

  assert.equal(receivedInput.hubLocationId, 3);
  assert.equal(receivedInput.deviceName, 'Superintendent Laptop');
  assert.equal(receivedInput.deviceFingerprint, 'fingerprint-xyz');
  assert.equal(receivedInput.adminUserId, 'admin-42');
  assert.equal(receivedInput.ipAddress, '192.168.1.10');
});

test('registerDevice forwards service errors to the error handler', async () => {
  const expectedError = new Error('Device registration failed');

  service.registerDevice = async () => {
    throw expectedError;
  };

  const req = {
    body: {
      hubLocationId: 2,
      deviceName: 'Hub Laptop',
      deviceFingerprint: 'fingerprint-abc'
    },
    user: { userId: 'admin-1' },
    ip: '127.0.0.1'
  };

  const res = createResponse();
  let receivedError;

  await controller.registerDevice(req, res, (error) => {
    receivedError = error;
  });

  assert.equal(receivedError, expectedError);
});
