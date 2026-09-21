require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { generateSecret } = require('otplib');

const pool = require('../src/config/db');

const email = 'tradetester@nsp.com';
const password = 'TradeTester123';
const role = 'TRADE_TESTER';
const hubLocationId = 1;

async function createTradeTester() {
    try {
        // Hash password
        const passwordHash = await bcrypt.hash(password, 12);

        // Generate TOTP secret
        const mfaSecret = generateSecret();

        // Encryption key
        const key = Buffer.from(process.env.MFA_ENCRYPTION_KEY, 'hex');

        if (key.length !== 32) {
            throw new Error('MFA_ENCRYPTION_KEY must be exactly 32 bytes');
        }

        // Encrypt MFA secret
        const iv = crypto.randomBytes(12);

        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

        let encrypted = cipher.update(mfaSecret, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag().toString('hex');

        const encryptedMfaSecret =
            `${iv.toString('hex')}:${authTag}:${encrypted}`;

        // Insert user into database
        const result = await pool.query(
            `
            INSERT INTO auth.users
                (email, password_hash, role, hub_location_id, mfa_secret)
            VALUES
                ($1, $2, $3, $4, $5)
            RETURNING user_id, email, role, hub_location_id, is_mfa_active, created_at;
            `,
            [
                email,
                passwordHash,
                role,
                hubLocationId,
                encryptedMfaSecret
            ]
        );

        console.log('Trade Tester created successfully:');
        console.log(result.rows[0]);

        // Important: show the MFA secret only once.
        console.log('\nIMPORTANT - SAVE THIS MFA SECRET SECURELY:');
        console.log(mfaSecret);
    } catch (error) {
        console.error('Failed to create Trade Tester:', error.message);
    } finally {
        await pool.end();
    }
}

createTradeTester();