
/**
 * B1 Integration Tests: Step-up MFA Middleware
 *
 * Tests the actual requireStepUp middleware:
 * - Missing and invalid tokens
 * - Expired tokens
 * - Scope mismatch
 * - Wrong user/session
 * - Successful authorization
 * - Single-use token enforcement
 * - Invalid scope configuration
 *
 * Uses temporary RSA keys and an in-memory fake database.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// IMPORTANT: Initialize test environment before importing src modules.
const {
    signStepUpToken,
    stubModule
} = require('./helpers/testEnv');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const SCOPE = 'APPROVE_ASSESSMENT';

// In-memory database for step-up tokens.
const storedTokens = new Map();

// Fake database pool.
// The middleware only needs the atomic UPDATE query.
const fakePool = {
    async query(sql, params) {
        if (sql.includes('UPDATE auth.step_up_tokens')) {
            const [tokenHash, userId, sessionId, scope] = params;

            const stored = storedTokens.get(tokenHash);

            if (
                !stored ||
                stored.userId !== userId ||
                stored.sessionId !== sessionId ||
                stored.scope !== scope ||
                stored.used ||
                stored.expiresAt <= Date.now()
            ) {
                return {
                    rowCount: 0,
                    rows: []
                };
            }

            // Mark token as consumed.
            // This happens synchronously before returning.
            stored.used = true;

            return {
                rowCount: 1,
                rows: [{ token_hash: tokenHash }]
            };
        }

        throw new Error(
            `Unexpected SQL in step-up test: ${sql.slice(0, 100)}`
        );
    }
};

// Replace database module before loading auth middleware.
stubModule('config/db', fakePool);

const { requireStepUp } = require('../src/modules/auth/auth.middleware');

// Helper: create an Express-like response object.
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

// Helper: create request with an authenticated user.
const createRequest = ({
    token,
    userId = USER_ID,
    sessionId = SESSION_ID
} = {}) => ({
    headers: token
        ? { 'x-step-up-token': token }
        : {},

    user: {
        userId,
        sessionId
    }
});

// Helper: seed a valid token into the fake database.
const seedToken = ({
    userId = USER_ID,
    sessionId = SESSION_ID,
    scope = SCOPE,
    expiresIn = '5m'
} = {}) => {
    const tokenData = signStepUpToken({
        userId,
        sessionId,
        scope,
        expiresIn
    });

    storedTokens.set(tokenData.tokenHash, {
        userId,
        sessionId,
        scope,
        expiresAt: tokenData.expiresAt.getTime(),
        used: false
    });

    return tokenData;
};

// Reset fake database before each test.
beforeEach(() => {
    storedTokens.clear();
});

// ======================================================
// TEST 1: Missing token
// ======================================================

test('B1-01: Rejects request when step-up token is missing', async () => {
    const middleware = requireStepUp(SCOPE);

    const req = createRequest();
    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.match(res.body.message, /required/i);
});

// ======================================================
// TEST 2: Invalid token
// ======================================================

test('B1-02: Rejects malformed step-up token', async () => {
    const middleware = requireStepUp(SCOPE);

    const req = createRequest({
        token: 'invalid.token.value'
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.match(res.body.message, /invalid|expired/i);
});

// ======================================================
// TEST 3: Expired token
// ======================================================

test('B1-03: Rejects expired step-up token', async () => {
    const tokenData = signStepUpToken({
        userId: USER_ID,
        sessionId: SESSION_ID,
        scope: SCOPE,
        expiresIn: '-1s'
    });

    const middleware = requireStepUp(SCOPE);

    const req = createRequest({
        token: tokenData.token
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

// ======================================================
// TEST 4: Wrong scope
// ======================================================

test('B1-04: Rejects token issued for a different scope', async () => {
    const tokenData = seedToken({
        scope: 'REVOKE_CREDENTIAL'
    });

    const middleware = requireStepUp('APPROVE_ASSESSMENT');

    const req = createRequest({
        token: tokenData.token
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
    assert.match(res.body.message, /does not authorize/i);
});

// ======================================================
// TEST 5: Wrong user
// ======================================================

test('B1-05: Rejects token belonging to another user', async () => {
    const tokenData = seedToken();

    const anotherUserId =
        '33333333-3333-4333-8333-333333333333';

    const middleware = requireStepUp(SCOPE);

    const req = createRequest({
        token: tokenData.token,
        userId: anotherUserId
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

// ======================================================
// TEST 6: Wrong session
// ======================================================

test('B1-06: Rejects token belonging to another session', async () => {
    const tokenData = seedToken();

    const anotherSessionId =
        '44444444-4444-4444-8444-444444444444';

    const middleware = requireStepUp(SCOPE);

    const req = createRequest({
        token: tokenData.token,
        sessionId: anotherSessionId
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

// ======================================================
// TEST 7: Successful authorization
// ======================================================

test('B1-07: Allows valid token and consumes it successfully', async () => {
    const tokenData = seedToken();

    const middleware = requireStepUp(SCOPE);

    const req = createRequest({
        token: tokenData.token
    });

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);

    assert.deepEqual(req.stepUp, {
        scope: SCOPE,
        tokenId: tokenData.jti
    });

    const stored = storedTokens.get(tokenData.tokenHash);

    assert.equal(stored.used, true);
});

// ======================================================
// TEST 8: Token replay
// ======================================================

test('B1-08: Rejects reuse of an already-consumed token', async () => {
    const tokenData = seedToken();

    const middleware = requireStepUp(SCOPE);

    // First request consumes the token.
    const firstReq = createRequest({
        token: tokenData.token
    });

    const firstRes = createResponse();

    let firstNextCalled = false;

    await middleware(firstReq, firstRes, () => {
        firstNextCalled = true;
    });

    assert.equal(firstNextCalled, true);

    // Second request attempts to reuse the same token.
    const secondReq = createRequest({
        token: tokenData.token
    });

    const secondRes = createResponse();

    let secondNextCalled = false;

    await middleware(secondReq, secondRes, () => {
        secondNextCalled = true;
    });

    assert.equal(secondRes.statusCode, 401);
    assert.equal(secondNextCalled, false);
    assert.match(secondRes.body.message, /already used/i);
});

// ======================================================
// TEST 9: Missing authenticated session
// ======================================================

test('B1-09: Rejects request without authenticated session', async () => {
    const tokenData = seedToken();

    const middleware = requireStepUp(SCOPE);

    const req = {
        headers: {
            'x-step-up-token': tokenData.token
        },
        user: {
            userId: USER_ID
            // sessionId intentionally missing
        }
    };

    const res = createResponse();

    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

// ======================================================
// TEST 10: Invalid scope configuration
// ======================================================

test('B1-10: Throws error when middleware is configured with invalid scope', () => {
    assert.throws(
        () => requireStepUp('INVALID_SCOPE'),
        /Invalid step-up scope/
    );
});

console.log('--- B1 STEP-UP MFA TESTS ---');
