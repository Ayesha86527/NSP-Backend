/**
 * Tests for the Phase 2 tooling: JWT key generator, .env template sync,
 * and the env checker's typo detection (the RELATER_PRIVATE_KEY mistake).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');
const { Wallet } = require('ethers');

const { generateJwtKeys } = require('../scripts/generateJwtKeys');
const validateEnv = require('../src/config/validateEnv');

const root = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-tooling-'));

test('generateJwtKeys writes a usable RS256 key pair', () => {
    const dir = tmp();
    const { privatePath, publicPath } = generateJwtKeys({ outDir: dir });
    const token = jwt.sign({ sub: 'u1' }, fs.readFileSync(privatePath, 'utf8'), { algorithm: 'RS256' });
    const decoded = jwt.verify(token, fs.readFileSync(publicPath, 'utf8'), { algorithms: ['RS256'] });
    assert.equal(decoded.sub, 'u1');
});

test('generateJwtKeys refuses to overwrite existing keys unless --force', () => {
    const dir = tmp();
    generateJwtKeys({ outDir: dir });
    const before = fs.readFileSync(path.join(dir, 'private.key'), 'utf8');
    assert.throws(() => generateJwtKeys({ outDir: dir }), /already exist/);
    assert.equal(fs.readFileSync(path.join(dir, 'private.key'), 'utf8'), before);
    generateJwtKeys({ outDir: dir, force: true });
    assert.notEqual(fs.readFileSync(path.join(dir, 'private.key'), 'utf8'), before);
});

test('generated keys satisfy the startup validator', () => {
    const dir = tmp();
    generateJwtKeys({ outDir: dir });
    const env = {
        DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p',
        MFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        CNIC_DEDUP_SECRET: crypto.randomBytes(32).toString('hex'),
        CORS_ALLOWED_ORIGINS: 'https://issuer.example.gov.pk',
        AWS_REGION: 'ap-south-1', AWS_S3_BUCKET: 'b',
        REDIS_URL: 'redis://127.0.0.1:6379',
        POLYGON_AMOY_RPC_URL: 'https://rpc-amoy.polygon.technology',
        RELAYER_PRIVATE_KEY: Wallet.createRandom().privateKey,
        CERTIFICATE_LOGIC_CONTRACT_ADDRESS: Wallet.createRandom().address
    };
    assert.doesNotThrow(() => validateEnv(env, { keysDirectory: dir }));
});

test('the misspelt RELATER_PRIVATE_KEY is reported as a missing RELAYER_PRIVATE_KEY', () => {
    const dir = tmp();
    generateJwtKeys({ outDir: dir });
    assert.throws(
        () => validateEnv({ RELATER_PRIVATE_KEY: '0x' + 'a'.repeat(64) }, { keysDirectory: dir }),
        /RELAYER_PRIVATE_KEY/
    );
});

test('npm run check:env points out a typo in a variable name', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.env'), 'RELATER_PRIVATE_KEY=0x' + 'a'.repeat(64) + '\n');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'checkEnv.js')], {
        cwd: dir,
        env: { PATH: process.env.PATH, JWT_KEYS_DIR: dir },
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Possible typo\(s\).*RELATER_PRIVATE_KEY/s);
});

test('.env.production.example stays in sync with the validator', () => {
    const text = fs.readFileSync(path.join(root, '.env.production.example'), 'utf8');
    for (const name of validateEnv.REQUIRED_VARIABLES) {
        assert.match(text, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.production.example`);
    }
});

test('.env.example (development) lists every required variable', () => {
    const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const name of validateEnv.REQUIRED_VARIABLES) {
        assert.match(text, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.example`);
    }
});