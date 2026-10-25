/**
 * Security & configuration hardening (Roadmap Phase 2, Days 6-8, Track B):
 *  - strict startup env validation (fail-fast)
 *  - PostgreSQL pool tuning
 *  - CORS allow-list
 *  - standard JSON errors / no TypeError on empty bodies
 */

const { ALLOWED_ORIGIN, stubModule, createFakeRedis } = require('./helpers/testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

stubModule('config/redis.js', createFakeRedis());

const validateEnv = require('../src/config/validateEnv');
const pool = require('../src/config/db');
const app = require('../src/app');
const errorHandler = require('../src/middleware/errorHandler');

// ---------------------------------------------------------------------------
// validateEnv
// ---------------------------------------------------------------------------

const keysDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-env-keys-'));
fs.writeFileSync(path.join(keysDirectory, 'private.key'), 'private');
fs.writeFileSync(path.join(keysDirectory, 'public.key'), 'public');
test.after(() => fs.rmSync(keysDirectory, { recursive: true, force: true }));

const validEnv = () => ({
    DB_HOST: 'db.internal',
    DB_PORT: '5432',
    DB_NAME: 'nsp',
    DB_USER: 'nsp_app',
    DB_PASSWORD: 'secret',
    MFA_ENCRYPTION_KEY: 'ab'.repeat(32),
    CNIC_DEDUP_SECRET: 'x'.repeat(40),
    CORS_ALLOWED_ORIGINS: 'https://issuer.example.gov.pk,https://verify.example.gov.pk',
    AWS_REGION: 'ap-south-1',
    AWS_S3_BUCKET: 'bucket',
    REDIS_URL: 'rediss://cache.internal:6379',
    POLYGON_AMOY_RPC_URL: 'https://rpc-amoy.example.com/key',
    RELAYER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    CERTIFICATE_LOGIC_CONTRACT_ADDRESS: Wallet.createRandom().address
});

const check = (overrides = {}, removals = []) => {
    const env = { ...validEnv(), ...overrides };
    removals.forEach((name) => delete env[name]);
    return () => validateEnv(env, { keysDirectory });
};

test('a complete, well-formed environment passes', () => {
    assert.doesNotThrow(check());
    assert.doesNotThrow(check({ NODE_ENV: 'production', DB_SSL: 'true' }));
});

test('every required variable is enforced (fail-fast)', () => {
    for (const name of validateEnv.REQUIRED_VARIABLES) {
        assert.throws(check({}, [name]), (error) => error.message.includes(name), `${name} should be required`);
        assert.throws(check({ [name]: '   ' }), (error) => error.message.includes(name), `${name} blank should fail`);
    }
});

test('all problems are reported together, not one at a time', () => {
    assert.throws(
        check({ MFA_ENCRYPTION_KEY: 'short', DB_PORT: '99999' }, ['DB_PASSWORD', 'REDIS_URL']),
        (error) =>
            ['DB_PASSWORD', 'REDIS_URL', 'MFA_ENCRYPTION_KEY', 'DB_PORT'].every((n) => error.message.includes(n))
    );
});

test('malformed values are rejected', () => {
    const bad = {
        MFA_ENCRYPTION_KEY: 'zz'.repeat(32),
        CNIC_DEDUP_SECRET: 'too-short',
        DB_PORT: '5432abc',
        PORT: '0',
        DB_SSL: 'yes',
        DB_POOL_MAX: '0',
        RATE_LIMIT_PER_MINUTE: '-5',
        TRUST_PROXY: 'maybe',
        REDIS_URL: 'http://cache:6379',
        POLYGON_AMOY_RPC_URL: 'http://rpc.example.com',
        RELAYER_PRIVATE_KEY: '0x1234',
        CERTIFICATE_LOGIC_CONTRACT_ADDRESS: '0xnotanaddress',
        MIN_GAS_THRESHOLD: 'lots'
    };

    for (const [name, value] of Object.entries(bad)) {
        assert.throws(check({ [name]: value }), (error) => error.message.includes(name), `${name}=${value}`);
    }
});

test('local http RPC is allowed only on loopback', () => {
    assert.doesNotThrow(check({ POLYGON_AMOY_RPC_URL: 'http://127.0.0.1:8545' }));
    assert.doesNotThrow(check({ POLYGON_AMOY_RPC_URL: 'http://localhost:8545' }));
    assert.throws(check({ POLYGON_AMOY_RPC_URL: 'http://10.0.0.5:8545' }), /HTTPS/);
});

test('CORS origins must be bare origins (no wildcard, path or trailing slash)', () => {
    for (const origin of ['*', 'https://a.example.com/', 'https://a.example.com/app', 'not a url', 'ftp://a.example.com']) {
        assert.throws(check({ CORS_ALLOWED_ORIGINS: origin }), /CORS/, origin);
    }
    assert.throws(check({ CORS_ALLOWED_ORIGINS: ' , ' }), /CORS/);
    assert.doesNotThrow(check({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' }));
});

test('production enforces HTTPS origins and verified TLS to the database', () => {
    assert.throws(
        check({ NODE_ENV: 'production', DB_SSL: 'true', CORS_ALLOWED_ORIGINS: 'http://issuer.example.com' }),
        /HTTPS in production/
    );
    assert.throws(check({ NODE_ENV: 'production' }), /DB_SSL must be "true"/);
    assert.throws(
        check({ NODE_ENV: 'production', DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' }),
        /DB_SSL_REJECT_UNAUTHORIZED/
    );
});

test('missing or empty JWT key files stop the boot', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-empty-keys-'));
    try {
        assert.throws(() => validateEnv(validEnv(), { keysDirectory: empty }), /private\.key/);
        fs.writeFileSync(path.join(empty, 'private.key'), '  ');
        fs.writeFileSync(path.join(empty, 'public.key'), 'x');
        assert.throws(() => validateEnv(validEnv(), { keysDirectory: empty }), /empty/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// PostgreSQL pool (NFR-PER-04)
// ---------------------------------------------------------------------------

test('PostgreSQL pool is tuned: max 20 connections, 30s idle timeout', () => {
    assert.equal(pool.options.max, 20);
    assert.equal(pool.options.idleTimeoutMillis, 30000);
    assert.ok(pool.listenerCount('error') >= 1, 'idle-client errors must not crash the process');
});

// ---------------------------------------------------------------------------
// HTTP behaviour
// ---------------------------------------------------------------------------

let server;
let base;
test.before(async () => {
    server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end().catch(() => {});
});

test('CORS: allow-listed origin is accepted and echoed', async () => {
    const response = await fetch(`${base}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
});

test('CORS: unknown origin is refused with a JSON 403 and no CORS headers', async () => {
    const response = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.match(body.message, /CORS/);
});

test('CORS: preflight from an allowed origin succeeds, from others fails', async () => {
    const ok = await fetch(`${base}/api/assessments`, {
        method: 'OPTIONS',
        headers: {
            Origin: ALLOWED_ORIGIN,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization,content-type,x-device-fingerprint'
        }
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);

    const bad = await fetch(`${base}/api/assessments`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(bad.status, 403);
});

test('CORS: non-browser clients (no Origin header) are not blocked', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('Helmet security headers are enabled', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('strict-transport-security'));
    assert.equal(response.headers.get('x-powered-by'), null);
});

test('login with no body returns 400, not a TypeError 500', async () => {
    for (const route of ['login', 'verify-mfa', 'verify-backup-code', 'refresh']) {
        const response = await fetch(`${base}/api/auth/${route}`, { method: 'POST' });
        assert.ok(response.status >= 400 && response.status < 500, `${route} -> ${response.status}`);
    }
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST' });
    assert.equal(response.status, 400);
});

test('malformed JSON returns a 400 JSON error', async () => {
    const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email": '
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
});

test('unknown routes return a standard 404 JSON error', async () => {
    const response = await fetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { success: false, message: 'Route not found' });
});

test('protected routes reject missing and forged tokens with 401', async () => {
    assert.equal((await fetch(`${base}/api/assessments/queue`)).status, 401);
    const forged = await fetch(`${base}/api/assessments/queue`, {
        headers: { Authorization: 'Bearer not.a.jwt' }
    });
    assert.equal(forged.status, 401);
});

test('error handler hides internal details of 5xx errors in production only', () => {
    const run = (nodeEnv, error) => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = nodeEnv;
        const originalConsole = console.error;
        console.error = () => {};
        let captured;
        const res = {
            headersSent: false,
            status(code) { captured = { code }; return this; },
            json(body) { captured.body = body; return this; }
        };
        try {
            errorHandler(error, {}, res, () => {});
        } finally {
            process.env.NODE_ENV = previous;
            console.error = originalConsole;
        }
        return captured;
    };

    const boom = new Error('connection to 10.0.0.5 refused');
    assert.deepEqual(run('production', boom), { code: 500, body: { success: false, message: 'Internal server error' } });
    assert.equal(run('development', boom).body.message, 'connection to 10.0.0.5 refused');

    const client = Object.assign(new Error('Candidate not found'), { statusCode: 404 });
    assert.deepEqual(run('production', client), { code: 404, body: { success: false, message: 'Candidate not found' } });

    const weird = Object.assign(new Error('x'), { statusCode: 'abc' });
    assert.equal(run('production', weird).code, 500);
});
