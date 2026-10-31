/**
 * Shared bootstrap for integration tests.
 *
 * MUST be required before anything from ../src, because src/app.js validates
 * the environment and src/config/jwt.js reads the RS256 keys at import time.
 * Nothing here touches a real database, Redis, S3 or blockchain node.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

// Throw-away RS256 key pair in a temp directory (cleaned up on exit).
const keysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-test-keys-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
fs.writeFileSync(path.join(keysDir, 'private.key'), privateKey);
fs.writeFileSync(path.join(keysDir, 'public.key'), publicKey);
process.on('exit', () => fs.rmSync(keysDir, { recursive: true, force: true }));

const ALLOWED_ORIGIN = 'https://issuer.test.example';
const TEST_CNIC = '3520112345671';

Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_NAME: 'nsp_test',
    DB_USER: 'nsp_test',
    DB_PASSWORD: 'not-a-real-password',
    MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    CNIC_DEDUP_SECRET: crypto.randomBytes(32).toString('hex'),
    CORS_ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},https://verify.test.example`,
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'nsp-test-bucket',
    REDIS_URL: 'redis://127.0.0.1:6399',
    POLYGON_AMOY_RPC_URL: 'http://127.0.0.1:8545',
    RELAYER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    CERTIFICATE_LOGIC_CONTRACT_ADDRESS: Wallet.createRandom().address,
    JWT_KEYS_DIR: keysDir
});

// Allow the full-lifecycle test to exceed 60 req/min; rate-limit behaviour is
// verified separately in security.hardening.test.js with the real default.
if (process.env.NSP_TEST_RATE_LIMIT) {
    process.env.RATE_LIMIT_PER_MINUTE = process.env.NSP_TEST_RATE_LIMIT;
}

/** Replace a module in the require cache before it is first loaded. */
const stubModule = (relativeFromSrc, exports) => {
    const id = require.resolve(path.join(__dirname, '..', '..', 'src', relativeFromSrc));
    require.cache[id] = { id, filename: id, loaded: true, exports };
    return exports;
};

/** Minimal in-memory Redis (get / setex / del / flushall). */
const createFakeRedis = () => {
    const store = new Map();
    return {
        store,
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async setex(key, _ttl, value) { store.set(key, value); return 'OK'; },
        async del(key) { return store.delete(key) ? 1 : 0; },
        async flushall() { store.clear(); return 'OK'; },
        on() {}
    };
};

/** Sign an access token exactly the way auth.middleware expects to verify it. */
const jwt = require('jsonwebtoken');

const signAccessToken = ({ userId, sessionId, tokenVersion = 0 }) =>
    jwt.sign({ sub: userId, sid: sessionId, tokenVersion }, privateKey, {
        algorithm: 'RS256',
        expiresIn: '15m'
    });

/** Sign a step-up token for B1 middleware tests. */
const signStepUpToken = ({
    userId,
    sessionId,
    scope,
    expiresIn = '5m'
}) => {
    const jti = crypto.randomUUID();

    const token = jwt.sign(
        {
            sub: userId,
            sid: sessionId,
            scope,
            purpose: 'step_up',
            jti
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn
        }
    );

    const decoded = jwt.decode(token);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    return {
        token,
        tokenHash,
        jti,
        expiresAt: new Date(decoded.exp * 1000)
    };
};

module.exports = {
    ALLOWED_ORIGIN,
    TEST_CNIC,
    stubModule,
    createFakeRedis,
    signAccessToken,
    signStepUpToken
};
