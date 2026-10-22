require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { generateSecret } = require('otplib');
const pool = require('../src/config/db');

const ADMIN_EMAIL = 'superadmin@nsp.com';
const ADMIN_PASSWORD = 'SuperAdmin@123';

async function main() {
  const encryptionKey = process.env.MFA_ENCRYPTION_KEY;

  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error(
      'MFA_ENCRYPTION_KEY must be set to exactly 64 hexadecimal characters in .env.'
    );
  }

  // Refuse to create a duplicate account.
  const existing = await pool.query(
    'SELECT user_id FROM auth.users WHERE email = $1',
    [ADMIN_EMAIL]
  );

  if (existing.rowCount > 0) {
    throw new Error(
      `${ADMIN_EMAIL} already exists. No account was created or changed.`
    );
  }

  // Generate a unique secret for Google Authenticator.
  const mfaSecret = generateSecret();

  // Encrypt the secret using the same AES-256-GCM storage format
  // used by the existing authentication service: IV:TAG:CIPHERTEXT.
  const key = Buffer.from(encryptionKey, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(mfaSecret, 'utf8'),
    cipher.final()
  ]);

  const encryptedSecret = [
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex')
  ].join(':');

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO auth.users (
        email,
        password_hash,
        role,
        hub_location_id,
        mfa_secret,
        is_mfa_active,
        failed_login_attempts
      )
      VALUES ($1, $2, 'SUPER_ADMIN', NULL, $3, FALSE, 0)
      RETURNING user_id, email, role`,
      [ADMIN_EMAIL, passwordHash, encryptedSecret]
    );

    await client.query('COMMIT');

    console.log('\nSuper Admin account created successfully.');
    console.log('Email:', result.rows[0].email);
    console.log('Role:', result.rows[0].role);
    console.log('Password:', ADMIN_PASSWORD);
    console.log('\nGoogle Authenticator setup key:', mfaSecret);
    console.log('\nIMPORTANT: MFA is currently inactive.');
    console.log(
      'Enroll this secret in Google Authenticator, then verify enrollment before enabling MFA.'
    );
    console.log(
      'Keep the setup key private. Do not commit it or share it.'
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error('Super Admin creation failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
