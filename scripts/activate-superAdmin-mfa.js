require('dotenv').config();

const crypto = require('crypto');
const readline = require('readline');
const { verify } = require('otplib');
const pool = require('../src/config/db');

const ADMIN_EMAIL = 'superadmin@nsp.com';

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function decryptMfaSecret(encryptedSecret, encryptionKey) {
  const parts = encryptedSecret.split(':');

  if (parts.length !== 3) {
    throw new Error('Stored MFA secret has an invalid format.');
  }

  const [ivHex, tagHex, ciphertextHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

async function main() {
  const encryptionKey = process.env.MFA_ENCRYPTION_KEY;

  if (!encryptionKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('MFA_ENCRYPTION_KEY is missing or invalid.');
  }

  const result = await pool.query(
    `SELECT user_id, email, role, mfa_secret, is_mfa_active
     FROM auth.users
     WHERE email = $1`,
    [ADMIN_EMAIL]
  );

  const user = result.rows[0];

  if (!user || user.role !== 'SUPER_ADMIN') {
    throw new Error('Super Admin account was not found.');
  }

  if (user.is_mfa_active) {
    console.log('MFA is already active for this account.');
    return;
  }

  if (!user.mfa_secret) {
    throw new Error('No MFA secret is stored for this account.');
  }

  const secret = decryptMfaSecret(user.mfa_secret, encryptionKey);
  const token = await ask('Enter the current 6-digit Google Authenticator code: ');

  if (!/^\d{6}$/.test(token)) {
    throw new Error('Enter a valid six-digit code.');
  }

  const verification = await verify({ secret, token });

  if (!verification.valid) {
    throw new Error('Code verification failed. MFA remains inactive. Try a current code.');
  }

  const update = await pool.query(
    `UPDATE auth.users
     SET is_mfa_active = TRUE
     WHERE user_id = $1
       AND role = 'SUPER_ADMIN'
       AND is_mfa_active = FALSE
     RETURNING email, role, is_mfa_active`,
    [user.user_id]
  );

  if (!update.rowCount) {
    throw new Error('Account status changed before MFA activation. Check the account.');
  }

  console.log('\nMFA successfully verified and activated.');
  console.log('Email:', update.rows[0].email);
  console.log('Role:', update.rows[0].role);
  console.log('MFA active:', update.rows[0].is_mfa_active);
}

main()
  .catch((error) => {
    console.error('\nMFA enrollment failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
