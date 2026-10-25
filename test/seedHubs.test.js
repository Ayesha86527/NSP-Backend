/**
 * scripts/seedHubs.js (Roadmap Phase 2, Day 10): 5 testing hubs, each with a
 * Trade Tester and a Center Superintendent. Idempotent, passwords never logged.
 */

require('./helpers/testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pool = require('../src/config/db');
const superAdminModel = require('../src/modules/superAdmin/superAdmin.model');
const seed = require('../scripts/seedHubs');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsp-seed-'));
test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

const capture = async (fn) => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return lines.join('\n');
};

const install = ({ existingEmails = [] } = {}) => {
    const created = [];
    pool.query = async () => ({ rows: existingEmails.map((email) => ({ email })) });
    pool.end = async () => {};
    superAdminModel.createManagedUser = async (input) => {
        created.push(input);
        return { user_id: 'x', ...input };
    };
    return created;
};

test('plan covers hubs 1-5 with exactly one tester and one superintendent each', () => {
    const plan = seed.buildPlan();
    assert.equal(plan.length, 10);
    assert.equal(new Set(plan.map((p) => p.email)).size, 10);

    for (const hubId of [1, 2, 3, 4, 5]) {
        const roles = plan.filter((p) => p.hubId === hubId).map((p) => p.role).sort();
        assert.deepEqual(roles, ['CENTER_SUPERINTENDENT', 'TRADE_TESTER']);
    }
});

test('generated passwords are strong and unique', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => seed.makeInitialPassword()));
    assert.equal(passwords.size, 50);
    for (const password of passwords) {
        assert.ok(password.length >= 32);
        assert.match(password, /[A-Z]/);
        assert.match(password, /[a-z]/);
        assert.match(password, /\d/);
        assert.match(password, /[^A-Za-z0-9]/);
    }
});

test('dry run (default) writes nothing', async () => {
    const created = install();
    const output = await capture(() => seed.main([]));
    assert.equal(created.length, 0);
    assert.match(output, /DRY RUN/);
    assert.match(output, /To create: 10/);
});

test('--apply creates missing accounts, skips existing ones, stores passwords privately', async () => {
    const created = install({ existingEmails: ['tradetester.hub1@nsp.com', 'superintendent.hub5@nsp.com'] });
    const credentialsFile = path.join(workDir, 'creds.json');

    const output = await capture(() => seed.main(['--apply', '--credentials-out', credentialsFile]));

    assert.equal(created.length, 8);
    assert.ok(!created.some((c) => c.email === 'tradetester.hub1@nsp.com'));
    assert.ok(created.every((c) => c.hubLocationId >= 1 && c.hubLocationId <= 5));
    assert.ok(created.every((c) => typeof c.encryptedMfaSecret === 'string' && c.encryptedMfaSecret.split(':').length === 3));

    // Credentials: file mode 600, one entry per created account, and passwords are not logged.
    // Windows has no POSIX permission bits (always reports 0o666), so only check on Unix.
    if (process.platform !== 'win32') {
        const stat = fs.statSync(credentialsFile);
        assert.equal(stat.mode & 0o777, 0o600);
    }
    const saved = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    assert.equal(saved.accounts.length, 8);
    for (const account of saved.accounts) {
        assert.ok(!output.includes(account.initialPassword), 'password leaked to console');
        const createdInput = created.find((c) => c.email === account.email);
        assert.equal(createdInput.password, account.initialPassword);
    }
});

test('refuses to run if the credentials file already exists (never overwrites)', async () => {
    const created = install();
    const credentialsFile = path.join(workDir, 'existing.json');
    fs.writeFileSync(credentialsFile, '{}');

    await assert.rejects(
        () => capture(() => seed.main(['--apply', '--credentials-out', credentialsFile])),
        /already exists/
    );
    assert.equal(created.length, 0, 'no accounts may be created if passwords cannot be saved');
    assert.equal(fs.readFileSync(credentialsFile, 'utf8'), '{}');
});

test('is idempotent: nothing to do when every account exists', async () => {
    const all = seed.buildPlan().map((p) => p.email);
    const created = install({ existingEmails: all });
    const output = await capture(() => seed.main(['--apply', '--credentials-out', path.join(workDir, 'none.json')]));
    assert.equal(created.length, 0);
    assert.match(output, /Nothing to do/);
    assert.ok(!fs.existsSync(path.join(workDir, 'none.json')));
});

test('a concurrent-creation conflict (23505) is skipped, other accounts still saved', async () => {
    install();
    let calls = 0;
    superAdminModel.createManagedUser = async (input) => {
        calls += 1;
        if (calls === 3) throw Object.assign(new Error('duplicate'), { code: '23505' });
        return input;
    };
    const credentialsFile = path.join(workDir, 'partial.json');
    await capture(() => seed.main(['--apply', '--credentials-out', credentialsFile]));
    assert.equal(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).accounts.length, 9);
});

test('a hard failure still persists passwords of accounts already created', async () => {
    install();
    let calls = 0;
    superAdminModel.createManagedUser = async (input) => {
        calls += 1;
        if (calls === 4) throw new Error('database down');
        return input;
    };
    const credentialsFile = path.join(workDir, 'crash.json');
    await assert.rejects(() => capture(() => seed.main(['--apply', '--credentials-out', credentialsFile])), /database down/);
    assert.equal(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).accounts.length, 3);
});