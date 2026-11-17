require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { generateSecret, authenticator } = require('otplib');
const pool = require('../src/config/db');

// Parse CLI flags: --role=... --email=... --password=... --hub=...
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    acc[key] = value;
    return acc;
}, {});

const roleInput = (args.role || 'TRADE_TESTER').toUpperCase();
const email = (args.email || '').trim().toLowerCase();
const password = args.password || 'Test@12345';
const hubLocationId = args.hub ? parseInt(args.hub, 10) : 1;

const VALID_ROLES = {
    'TRADE_TESTER': 'TRADE_TESTER',
    'TESTER': 'TRADE_TESTER',
    'CENTER_SUPERINTENDENT': 'CENTER_SUPERINTENDENT',
    'SUPERINTENDENT': 'CENTER_SUPERINTENDENT',
    'SUPER_ADMIN': 'SUPER_ADMIN',
    'ADMIN': 'SUPER_ADMIN'
};

const role = VALID_ROLES[roleInput];

if (!role) {
    console.error(`❌ Invalid role: "${roleInput}". Allowed roles: TRADE_TESTER, CENTER_SUPERINTENDENT, SUPER_ADMIN`);
    process.exit(1);
}

if (!email) {
    console.error('❌ Please provide an email address.');
    console.log('\nUsage:');
    console.log('  node scripts/create-user-cli.js --role=TRADE_TESTER --email=tester1@nsp.com --password=SecretPassword123 --hub=1');
    console.log('  node scripts/create-user-cli.js --role=CENTER_SUPERINTENDENT --email=super1@nsp.com --password=SecretPassword123 --hub=1');
    console.log('  node scripts/create-user-cli.js --role=SUPER_ADMIN --email=admin2@nsp.com --password=SecretPassword123');
    process.exit(1);
}

function encryptMfa(secret) {
    const encryptionKey = process.env.MFA_ENCRYPTION_KEY;
    if (!encryptionKey) {
        throw new Error('MFA_ENCRYPTION_KEY is missing from .env');
    }
    const key = Buffer.from(encryptionKey, 'hex');
    if (key.length !== 32) {
        throw new Error('MFA_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

async function main() {
    try {
        console.log(`\n⏳ Checking user: ${email}...`);
        const existing = await pool.query('SELECT user_id, email, role FROM auth.users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            console.error(`⚠️  User "${email}" already exists with role: ${existing.rows[0].role}`);
            process.exit(1);
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const mfaSecret = generateSecret();
        const encryptedMfa = encryptMfa(mfaSecret);

        const hubId = role === 'SUPER_ADMIN' ? null : hubLocationId;

        const insertQuery = `
            INSERT INTO auth.users (
                email,
                password_hash,
                role,
                hub_location_id,
                mfa_secret,
                is_mfa_active,
                mfa_enrollment_pending,
                is_active
            )
            VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, TRUE)
            RETURNING user_id, email, role, hub_location_id, created_at;
        `;

        const result = await pool.query(insertQuery, [
            email,
            passwordHash,
            role,
            hubId,
            encryptedMfa
        ]);

        const user = result.rows[0];
        const otpauthUrl = authenticator.keyuri(email, 'NSP HUNAR', mfaSecret);

        console.log('\n======================================================');
        console.log('✅ USER CREATED SUCCESSFULLY');
        console.log('======================================================');
        console.log(`User ID:        ${user.user_id}`);
        console.log(`Email:          ${user.email}`);
        console.log(`Password:       ${password}`);
        console.log(`Role:           ${user.role}`);
        console.log(`Hub ID:         ${user.hub_location_id || 'Global (All Hubs)'}`);
        console.log('------------------------------------------------------');
        console.log('🔐 MFA / AUTHENTICATOR SETUP:');
        console.log(`Manual Key:     ${mfaSecret}`);
        console.log(`Authenticator:  ${otpauthUrl}`);
        console.log('------------------------------------------------------');
        console.log('💡 How to log in with this account:');
        console.log('1. Go to the NSP Login portal.');
        console.log(`2. Enter Email (${email}) and Password.`);
        console.log(`3. When prompted for 6-digit MFA, enter the TOTP code from your authenticator app using the Manual Key above.`);
        console.log('======================================================\n');

    } catch (err) {
        console.error('❌ Failed to create user:', err.message);
    } finally {
        await pool.end();
    }
}

main();
