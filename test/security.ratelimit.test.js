/**
 * Rate limiting (NFR-PER-02): 60 req/min per client IP on /api/auth/* and the
 * public verification route. Runs in its own process so the in-memory
 * counters start from zero. TRUST_PROXY=1 simulates one load balancer, so
 * X-Forwarded-For identifies the client.
 */

process.env.TRUST_PROXY = '1';
const { stubModule, createFakeRedis } = require('./helpers/testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');

stubModule('config/redis.js', createFakeRedis());
stubModule('modules/ledger/blockchain/contract.js', {
    getProvider: () => null,
    getReadOnlyContractInstance: () => { throw new Error('not used'); },
    getContractInstance: async () => { throw new Error('not used'); },
    checkRelayerBalance: async () => 0n
});

const pool = require('../src/config/db');
const ledgerModel = require('../src/modules/ledger/ledger.model');
const app = require('../src/app');

ledgerModel.getCredentialByStringId = async () => undefined; // -> 404, no DB

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

const hit = (path, ip, init = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { 'X-Forwarded-For': ip, ...(init.headers || {}) } });

test('/api/auth/*: first 60 requests per minute pass, the 61st gets 429', async () => {
    const ip = '203.0.113.10';
    for (let i = 1; i <= 60; i += 1) {
        const response = await hit('/api/auth/login', ip, { method: 'POST' });
        assert.equal(response.status, 400, `request ${i} should reach the controller`);
    }

    const blocked = await hit('/api/auth/login', ip, { method: 'POST' });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('ratelimit') || blocked.headers.get('ratelimit-policy'));
    const body = await blocked.json();
    assert.equal(body.success, false);
    assert.match(body.message, /Too many/);
});

test('limits are per client IP: another client is unaffected', async () => {
    const response = await hit('/api/auth/login', '203.0.113.99', { method: 'POST' });
    assert.equal(response.status, 400);
});

test('public verification: 60 req/min then 429 (DDoS mitigation)', async () => {
    const ip = '203.0.113.20';
    const url = `/api/verify/${encodeURIComponent('urn:uuid:00000000-0000-4000-8000-000000000000')}`;

    for (let i = 1; i <= 60; i += 1) {
        const response = await hit(url, ip);
        assert.equal(response.status, 404, `request ${i}`);
    }

    const blocked = await hit(url, ip);
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).message, /Too many/);
});

test('auth and verification use separate buckets from the general limiter', async () => {
    // 203.0.113.30 uses 59 verify calls + 1 auth call: neither bucket is full.
    const ip = '203.0.113.30';
    const url = `/api/verify/${encodeURIComponent('urn:uuid:00000000-0000-4000-8000-000000000000')}`;
    for (let i = 0; i < 30; i += 1) await hit(url, ip);
    for (let i = 0; i < 29; i += 1) await hit('/api/auth/login', ip, { method: 'POST' });
    assert.equal((await hit('/api/auth/login', ip, { method: 'POST' })).status, 400);
});

test('CORS preflights do not consume the rate-limit budget', async () => {
    const ip = '203.0.113.40';
    for (let i = 0; i < 80; i += 1) {
        await hit('/api/auth/login', ip, { method: 'OPTIONS' });
    }
    assert.equal((await hit('/api/auth/login', ip, { method: 'POST' })).status, 400);
});
