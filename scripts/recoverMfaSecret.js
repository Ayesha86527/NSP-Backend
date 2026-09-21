require('dotenv').config();

const crypto = require('crypto');
const pool = require('../src/config/db');

const decryptMfaSecret = (encryptedSecret) => {
    const parts = encryptedSecret.split(':');

    if (parts.length !== 3) {
        throw new Error('Invalid encrypted MFA secret format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    const key = Buffer.from(
        process.env.MFA_ENCRYPTION_KEY,
        'hex'
    );

    if (key.length !== 32) {
        throw new Error(
            'MFA_ENCRYPTION_KEY must be exactly 32 bytes'
        );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        iv
    );

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(
        encrypted,
        undefined,
        'utf8'
    );

    decrypted += decipher.final('utf8');

    return decrypted;
};

async function recoverMfaSecret() {
    try {
        const result = await pool.query(
            `
            SELECT mfa_secret
            FROM auth.users
            WHERE email = $1
            `,
            ['tradetester@nsp.com']
        );

        if (result.rows.length === 0) {
            throw new Error('Trade Tester user not found');
        }

        const encryptedSecret = result.rows[0].mfa_secret;

        const secret = decryptMfaSecret(encryptedSecret);

        console.log('\nYour existing TOTP secret is:');
        console.log(secret);
        console.log('\nDo not share this secret with anyone.\n');
    } catch (error) {
        console.error('Failed to recover MFA secret:', error.message);
    } finally {
        await pool.end();
    }
}

recoverMfaSecret();