
const crypto = require('crypto');
const { generateSecret, generateURI } = require('otplib');

const encryptMfaSecret = secret => {
  const keyHex = process.env.MFA_ENCRYPTION_KEY;

  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'MFA_ENCRYPTION_KEY must be 32 bytes represented as 64 hex characters'
    );
  }

  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

const createEncryptedMfaSecret = () => {
  const secret = generateSecret();

  const otpauthUrl = generateURI({
    issuer: 'NSP',
    label: 'NSP MFA',
    secret
  });

  return {
    secret,
    encryptedMfaSecret: encryptMfaSecret(secret),
    otpauthUrl
  };
};

module.exports = {
  encryptMfaSecret,
  createEncryptedMfaSecret
};
