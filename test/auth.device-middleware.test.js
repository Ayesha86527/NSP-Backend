
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { stubModule } = require('./helpers/testEnv');

const CREDENTIAL = 'a'.repeat(64);
const FINGERPRINT = 'test-device-fingerprint';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

let databaseDevice;
let queryCalls;
let databaseError;

const fakePool = {
    query: async (sql, params = []) => {
        queryCalls.push({ sql, params });

        if (databaseError) {
            throw databaseError;
        }

        if (sql.includes('auth.authorized_devices')) {
            return {
                rows: databaseDevice ? [{ ...databaseDevice }] : [],
                rowCount: databaseDevice ? 1 : 0
            };
        }

        throw new Error(`Unexpected database query: ${sql}`);
    }
};

stubModule('config/db', fakePool);
stubModule('config/jwt', {
    publicKey: 'test-public-key',
    privateKey: 'test-private-key',
    accessTokenExpiresIn: '15m'
});

const { authenticateDevice } = require('../src/modules/auth/auth.middleware');

const createDevice = overrides => ({
    device_id: DEVICE_ID,
    hub_location_id: 1,
    device_name: 'Test Hub Laptop',
    device_fingerprint: FINGERPRINT,
    edr_status: 'compliant',
    last_heartbeat_at: new Date(),
    revoked: false,
    ...overrides
});

const createRequest = ({
    credential = CREDENTIAL,
    fingerprint = FINGERPRINT
} = {}) => ({
    headers: {
        'x-device-credential': credential,
        'x-device-fingerprint': fingerprint
    }
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

const runMiddleware = async req => {
    const res = createResponse();
    let nextCalled = false;
    let nextError = null;

    await authenticateDevice(req, res, error => {
        if (error) {
            nextError = error;
        } else {
            nextCalled = true;
        }
    });

    return {
        req,
        res,
        nextCalled,
        nextError
    };
};

beforeEach(() => {
    databaseDevice = createDevice();
    queryCalls = [];
    databaseError = null;
});

// 1. Valid device credentials authenticate successfully.
test('authenticates a registered device with valid credentials', async () => {
    const req = createRequest();

    const result = await runMiddleware(req);

    assert.equal(result.nextCalled, true);
    assert.equal(result.nextError, null);
    assert.equal(result.req.device.deviceId, DEVICE_ID);
    assert.equal(result.req.device.hubLocationId, 1);
    assert.equal(result.req.device.deviceName, 'Test Hub Laptop');
    assert.equal(result.req.device.deviceFingerprint, FINGERPRINT);
    assert.equal(result.req.device.edrStatus, 'compliant');

    assert.equal(result.res.statusCode, null);
    assert.equal(queryCalls.length, 1);
});

// 2. The middleware hashes the credential before database lookup.
test('hashes the supplied credential before querying the database', async () => {
    await runMiddleware(createRequest());

    const expectedHash = crypto
        .createHash('sha256')
        .update(CREDENTIAL)
        .digest('hex');

    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0].params[0], expectedHash);
    assert.notEqual(queryCalls[0].params[0], CREDENTIAL);
});

// 3. Missing credential is rejected.
test('rejects a missing device credential', async () => {
    const req = {
        headers: {
            'x-device-fingerprint': FINGERPRINT
        }
    };

    const result = await runMiddleware(req);

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Valid device credentials are required'
    );
    assert.equal(queryCalls.length, 0);
});

// 4. Invalid credential format is rejected.
test('rejects a device credential that is not 64 hexadecimal characters', async () => {
    const result = await runMiddleware(
        createRequest({ credential: 'invalid-credential' })
    );

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Valid device credentials are required'
    );
    assert.equal(queryCalls.length, 0);
});

// 5. Missing fingerprint is rejected.
test('rejects a missing device fingerprint', async () => {
    const req = {
        headers: {
            'x-device-credential': CREDENTIAL
        }
    };

    const result = await runMiddleware(req);

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Valid device fingerprint is required'
    );
    assert.equal(queryCalls.length, 0);
});

// 6. An excessively long fingerprint is rejected.
test('rejects a fingerprint longer than 255 characters', async () => {
    const result = await runMiddleware(
        createRequest({ fingerprint: 'a'.repeat(256) })
    );

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Valid device fingerprint is required'
    );
    assert.equal(queryCalls.length, 0);
});

// 7. Unknown credential is rejected.
test('rejects a credential that does not belong to a registered device', async () => {
    databaseDevice = null;

    const result = await runMiddleware(createRequest());

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Device authentication failed'
    );
    assert.equal(queryCalls.length, 1);
});

// 8. Fingerprint mismatch is rejected.
test('rejects a fingerprint that does not match the credential device', async () => {
    const result = await runMiddleware(
        createRequest({ fingerprint: 'different-device-fingerprint' })
    );

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(
        result.res.body.message,
        'Device authentication failed'
    );
});

// 9. Revoked device is always rejected.
test('rejects a revoked device with HTTP 403', async () => {
    databaseDevice = createDevice({ revoked: true });

    const result = await runMiddleware(createRequest());

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 403);
    assert.equal(
        result.res.body.message,
        'This device has been revoked'
    );
});

// 10. Fingerprint normalization supports uppercase and surrounding spaces.
test('normalizes incoming fingerprint before comparing it', async () => {
    const result = await runMiddleware(
        createRequest({
            fingerprint: `  ${FINGERPRINT.toUpperCase()}  `
        })
    );

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.device.deviceId, DEVICE_ID);
});

// 11. Heartbeat authentication remains available during hub lockdown.
// The middleware intentionally does not query hub lockdown.
test('allows heartbeat authentication without checking hub lockdown', async () => {
    databaseDevice = createDevice({
        edr_status: 'compliant'
    });

    const result = await runMiddleware(createRequest());

    assert.equal(result.nextCalled, true);
    assert.equal(queryCalls.length, 1);
    assert.equal(
        queryCalls[0].sql.includes('hub_device_lockdowns'),
        false
    );
});

// 12. Non-compliant EDR does not prevent heartbeat authentication.
test('allows heartbeat authentication when EDR is non-compliant', async () => {
    databaseDevice = createDevice({
        edr_status: 'non_compliant'
    });

    const result = await runMiddleware(createRequest());

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.device.edrStatus, 'non_compliant');
});

// 13. Database errors are passed to Express error handling.
test('passes database errors to next(error)', async () => {
    databaseError = new Error('Database unavailable');

    const result = await runMiddleware(createRequest());

    assert.equal(result.nextCalled, false);
    assert.equal(result.nextError, databaseError);
});
