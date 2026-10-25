/**
 * Seed the 5 NSP testing hubs with one Trade Tester and one Center
 * Superintendent account each (Roadmap Phase 2, Day 10).
 *
 *   node scripts/seedHubs.js                     # dry run (default, no writes)
 *   node scripts/seedHubs.js --apply             # create missing accounts
 *   node scripts/seedHubs.js --apply --credentials-out ./seed-credentials.json
 *
 * - Connects with the same DB_* environment variables as the API
 *   (set DB_HOST/DB_PORT in .env to use an SSH tunnel; nothing is hard-coded).
 * - Idempotent: accounts that already exist are skipped, never modified.
 * - Each new account gets a random one-time password. Passwords are NEVER
 *   printed; they are written once to a credentials file (mode 0600) that is
 *   refused if it already exists. Users must change nothing else: at first login
 *   the normal MFA enrolment flow starts automatically.
 */

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HUB_IDS = [1, 2, 3, 4, 5];
const ROLES = [
    { role: 'TRADE_TESTER', prefix: 'tradetester' },
    { role: 'CENTER_SUPERINTENDENT', prefix: 'superintendent' }
];

const makeEmail = (prefix, hubId) => `${prefix}.hub${hubId}@nsp.com`;

// 24 random bytes + suffix guarantees upper, lower, digit and symbol classes.
const makeInitialPassword = () => `${crypto.randomBytes(24).toString('base64url')}Aa1!`;

const buildPlan = () =>
    HUB_IDS.flatMap((hubId) =>
        ROLES.map(({ role, prefix }) => ({
            hubId,
            role,
            email: makeEmail(prefix, hubId)
        }))
    );

const parseArgs = (argv) => {
    const outIndex = argv.indexOf('--credentials-out');

    return {
        apply: argv.includes('--apply'),
        credentialsOut:
            outIndex !== -1 && argv[outIndex + 1]
                ? path.resolve(argv[outIndex + 1])
                : path.resolve('seed-credentials.json')
    };
};

const assertConfig = () => {
    const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'MFA_ENCRYPTION_KEY']
        .filter((key) => !process.env[key]);

    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (!/^[0-9a-fA-F]{64}$/.test(process.env.MFA_ENCRYPTION_KEY)) {
        throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes represented as 64 hex characters');
    }
};

async function main(argv = process.argv.slice(2)) {
    const { apply, credentialsOut } = parseArgs(argv);

    assertConfig();

    // Loaded after config validation so a bad environment fails before any connection.
    const pool = require('../src/config/db');
    const { createEncryptedMfaSecret } = require('../src/modules/auth/mfaSecret');
    const superAdminModel = require('../src/modules/superAdmin/superAdmin.model');

    try {
        const plan = buildPlan();

        const existing = await pool.query(
            `SELECT LOWER(email) AS email
               FROM auth.users
              WHERE LOWER(email) = ANY($1::text[])`,
            [plan.map((item) => item.email)]
        );
        const existingEmails = new Set(existing.rows.map((row) => row.email));
        const toCreate = plan.filter((item) => !existingEmails.has(item.email));

        console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
        console.log(`Accounts planned: ${plan.length}`);
        console.log(`Already present: ${plan.length - toCreate.length}`);
        console.log(`To create: ${toCreate.length}`);

        if (!apply) {
            console.log('Preview only. Run with --apply to create the missing accounts.');
            return;
        }

        if (toCreate.length === 0) {
            console.log('Nothing to do.');
            return;
        }

        // Refuse to continue if we cannot safely store the passwords afterwards.
        if (fs.existsSync(credentialsOut)) {
            throw new Error(
                `Credentials file already exists: ${credentialsOut}. ` +
                'Move it or pass --credentials-out <new-path>.'
            );
        }

        const issued = [];
        let skipped = 0;

        try {
            for (const item of toCreate) {
                const password = makeInitialPassword();
                const { encryptedMfaSecret } = createEncryptedMfaSecret();

                try {
                    await superAdminModel.createManagedUser({
                        email: item.email,
                        password,
                        role: item.role,
                        hubLocationId: item.hubId,
                        encryptedMfaSecret
                    });

                    issued.push({ ...item, initialPassword: password });
                    console.log(`Created ${item.role} for hub ${item.hubId}: ${item.email}`);
                } catch (error) {
                    // 23505 = unique_violation: created concurrently by another run.
                    if (error.code === '23505') {
                        skipped += 1;
                        console.log(`Skipped existing account: ${item.email}`);
                        continue;
                    }

                    throw error;
                }
            }
        } finally {
            // Always persist passwords for accounts that WERE created, even if a
            // later account failed, so no created account is left unusable.
            if (issued.length > 0) {
                fs.writeFileSync(
                    credentialsOut,
                    `${JSON.stringify({ generatedAt: new Date().toISOString(), accounts: issued }, null, 2)}\n`,
                    { mode: 0o600, flag: 'wx' }
                );
                console.log(`One-time credentials written to ${credentialsOut} (mode 600).`);
                console.log('Distribute them securely, then delete the file.');
            }
        }

        console.log(`Finished. Created: ${issued.length}; skipped: ${skipped}.`);
        console.log('Each user completes MFA enrolment at first login.');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Hub seeding failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { main, buildPlan, makeEmail, makeInitialPassword, parseArgs, HUB_IDS, ROLES };
