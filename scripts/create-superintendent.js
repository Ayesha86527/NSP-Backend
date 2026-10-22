require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { generateSecret } = require('otplib');

const pool = require('../src/config/db');

const EMAIL = 'superintendent@nsp.com';
const PASSWORD = 'Superintendent@123';
const ROLE = 'CENTER_SUPERINTENDENT';
const HUB_LOCATION_ID = 1;

const encryptMfaSecret = (secret) => {
    if (!process.env.MFA_ENCRYPTION_KEY) {
        throw new Error(
            'MFA_ENCRYPTION_KEY is not configured'
        );
    }

    const key = Buffer.from(
        process.env.MFA_ENCRYPTION_KEY,
        'hex'
    );

    if (key.length !== 32) {
        throw new Error(
            'MFA_ENCRYPTION_KEY must be exactly 32 bytes'
        );
    }

    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        key,
        iv
    );

    let encrypted = cipher.update(
        secret,
        'utf8',
        'hex'
    );

    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return [
        iv.toString('hex'),
        authTag.toString('hex'),
        encrypted
    ].join(':');
};

const main = async () => {
    try {
        const existing = await pool.query(
            `
            SELECT user_id, email, role
            FROM auth.users
            WHERE email = $1
            `,
            [EMAIL]
        );

        if (existing.rows.length > 0) {
            console.log(
                'User already exists:',
                existing.rows[0]
            );

            return;
        }

        const passwordHash = await bcrypt.hash(
            PASSWORD,
            12
        );

        const mfaSecret = generateSecret();

        const encryptedMfaSecret =
            encryptMfaSecret(mfaSecret);

        const result = await pool.query(
            `
            INSERT INTO auth.users (
                email,
                password_hash,
                role,
                hub_location_id,
                mfa_secret,
                is_mfa_active
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                TRUE
            )
            RETURNING
                user_id,
                email,
                role,
                hub_location_id
            `,
            [
                EMAIL,
                passwordHash,
                ROLE,
                HUB_LOCATION_ID,
                encryptedMfaSecret
            ]
        );

        console.log('');
        console.log('Superintendent created successfully.');
        console.log('');
        console.log(result.rows[0]);
        console.log('');
        console.log('Login email:', EMAIL);
        console.log('Login password:', PASSWORD);
        console.log('MFA secret:', mfaSecret);
        console.log('');
        console.log(
            'Use the MFA secret with your authenticator app.'
        );

    } catch (error) {
        console.error(
            'Failed to create Superintendent:',
            error.message
        );

        process.exitCode = 1;
    } finally {
        await pool.end();
    }
};

main();