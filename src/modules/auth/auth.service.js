const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify, generateSecret, generateURI } = require('otplib');

const pool = require('../../config/db');
const { privateKey, accessTokenExpiresIn } = require('../../config/jwt');
const { createAuditLog } = require('./audit.model');

const {
  findUserByEmail,
  findUserForMfa,
  findSessionByRefreshTokenHash,
  findUserById,
  revokeSession,
  rotateRefreshToken,
  recordFailedLogin,
  resetFailedLoginAttempts
} = require('./auth.model');

const {
  generateBackupCodesIfAbsent,
  verifyAndConsumeBackupCode,
  getBackupCodeStatus
} = require('./backupCode.model');

const getAllowedAuthRole = role =>
  ['TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'].includes(role);

const logAuditSafely = async ({
  userId = null,
  eventType,
  email = null,
  ipAddress = null,
  details = null
}) => {
  try {
    await createAuditLog({
      userId,
      eventType,
      email,
      ipAddress,
      details
    });
  } catch (error) {
    console.error('[AUDIT] Failed to write audit log:', error.message);
  }
};

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

/*
 * Create a new MFA secret and its encrypted database representation.
 * The plaintext secret and setup URI must only be returned to an
 * appropriately authorized user during MFA enrollment.
 */
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

const decryptMfaSecret = encryptedSecret => {
  if (!encryptedSecret) {
    throw new Error('MFA secret is missing');
  }

  const parts = encryptedSecret.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted MFA secret format');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const keyHex = process.env.MFA_ENCRYPTION_KEY;

  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('MFA_ENCRYPTION_KEY is not configured correctly');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
};

const createAccessToken = user => {
  if (!Number.isInteger(Number(user.token_version))) {
    throw new Error('User token version is missing');
  }

  return jwt.sign(
    {
      sub: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id,
      tokenVersion: Number(user.token_version)
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: accessTokenExpiresIn
    }
  );
};

const getSecurityUser = async userId => {
  const result = await pool.query(
    `SELECT user_id, email, role, hub_location_id,
            password_hash, mfa_secret, is_mfa_active,
            mfa_enrollment_pending, admin_locked,
            token_version, failed_login_attempts, locked_until
       FROM auth.users
      WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0] || null;
};

const isTemporarilyLocked = user =>
  user.locked_until && new Date(user.locked_until) > new Date();

const isAdminLocked = user => user.admin_locked === true;

const makeRefreshToken = () => crypto.randomBytes(40).toString('hex');

const hashRefreshToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

const createSession = async (user, ipAddress) => {
  const refreshToken = makeRefreshToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO auth.sessions
        (user_id, refresh_token_hash, ip_address, expires_at, revoked)
      VALUES ($1, $2, $3, $4, FALSE)`,
    [
      user.user_id,
      hashRefreshToken(refreshToken),
      ipAddress || '127.0.0.1',
      expiresAt
    ]
  );

  return {
    accessToken: createAccessToken(user),
    refreshToken
  };
};

const login = async (email, password, ipAddress = null) => {
  const foundUser = await findUserByEmail(email);

  if (!foundUser) {
    await logAuditSafely({
      eventType: 'AUTH_LOGIN_FAILED',
      email,
      ipAddress,
      details: { reason: 'USER_NOT_FOUND' }
    });

    return { success: false, message: 'Invalid email or password' };
  }

  // Load security flags directly from the database instead of relying
  // on findUserByEmail to return newly added columns.
  const user = await getSecurityUser(foundUser.user_id);

  if (!user) {
    return { success: false, message: 'Invalid email or password' };
  }

  if (isAdminLocked(user) || isTemporarilyLocked(user)) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_LOGIN_BLOCKED',
      email: user.email,
      ipAddress,
      details: {
        reason: isAdminLocked(user) ? 'ADMIN_LOCKED' : 'TEMPORARY_LOCKOUT'
      }
    });

    return { success: false, message: 'Account is locked' };
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches) {
    const failed = await recordFailedLogin(user.user_id);

    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_LOGIN_FAILED',
      email: user.email,
      ipAddress,
      details: { reason: 'INVALID_PASSWORD' }
    });

    return {
      success: false,
      message: failed && failed.failed_login_attempts >= 5
        ? 'Account locked for 15 minutes due to too many failed login attempts.'
        : 'Invalid email or password'
    };
  }

  if (!getAllowedAuthRole(user.role)) {
    return { success: false, message: 'Access denied' };
  }

  if (user.mfa_enrollment_pending || !user.is_mfa_active) {
    await resetFailedLoginAttempts(user.user_id);

    const enrollmentToken = jwt.sign(
      {
        sub: user.user_id,
        email: user.email,
        role: user.role,
        tokenVersion: Number(user.token_version),
        purpose: 'mfa_enrollment'
      },
      privateKey,
      {
        algorithm: 'RS256',
        expiresIn: '5m'
      }
    );

    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_MFA_ENROLLMENT_REQUIRED',
      email: user.email,
      ipAddress
    });

    return {
      success: true,
      mfaRequired: false,
      enrollmentRequired: true,
      enrollmentToken,
      message: 'Password verified. MFA enrollment is required.',
      user: {
        id: user.user_id,
        email: user.email,
        role: user.role,
        hubLocationId: user.hub_location_id
      }
    };
  }

  await resetFailedLoginAttempts(user.user_id);

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_PASSWORD_VERIFIED',
    email: user.email,
    ipAddress,
    details: { nextStep: 'MFA_REQUIRED' }
  });

  return {
    success: true,
    message: 'Password verified. MFA verification required.',
    mfaRequired: true,
    user: {
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id
    }
  };
};

const startMfaEnrollment = async (userId, ipAddress = null) => {
  const user = await getSecurityUser(userId);

  if (!user || isAdminLocked(user) || isTemporarilyLocked(user)) {
    return { success: false, message: 'Account unavailable' };
  }

  const secret = generateSecret();
  const encryptedSecret = encryptMfaSecret(secret);

  await pool.query(
    `UPDATE auth.users
        SET mfa_secret = $2,
            is_mfa_active = FALSE,
            mfa_enrollment_pending = TRUE
      WHERE user_id = $1`,
    [userId, encryptedSecret]
  );

  const otpauthUrl = generateURI({
    issuer: 'NSP',
    label: user.email,
    secret
  });

  await logAuditSafely({
    userId,
    eventType: 'AUTH_MFA_ENROLLMENT_STARTED',
    email: user.email,
    ipAddress
  });

  return {
    success: true,
    message: 'Scan the authenticator setup URI and verify a code to finish enrollment.',
    secret,
    otpauthUrl
  };
};

const confirmMfaEnrollment = async (userId, code, ipAddress = null) => {
  const user = await getSecurityUser(userId);

  if (
    !user ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    !user.mfa_enrollment_pending
  ) {
    return { success: false, message: 'MFA enrollment is not pending' };
  }

  let result;

  try {
    const secret = decryptMfaSecret(user.mfa_secret);
    result = await verify({
      secret,
      token: String(code || '')
    });
  } catch (error) {
    console.error(
      '[MFA ENROLLMENT VERIFY ERROR]',
      error.message
    );
    result = { valid: false };
  }

  if (!result.valid) {
    await logAuditSafely({
      userId,
      eventType: 'AUTH_MFA_ENROLLMENT_FAILED',
      email: user.email,
      ipAddress,
      details: { reason: 'INVALID_CODE' }
    });

    return { success: false, message: 'Invalid MFA code' };
  }

  await pool.query(
    `UPDATE auth.users
        SET is_mfa_active = TRUE,
            mfa_enrollment_pending = FALSE,
            failed_mfa_attempts = 0
      WHERE user_id = $1`,
    [userId]
  );

  await logAuditSafely({
    userId,
    eventType: 'AUTH_MFA_ENROLLMENT_COMPLETED',
    email: user.email,
    ipAddress
  });

  return {
    success: true,
    message: 'MFA enrollment completed. Log in using your password and authenticator code.'
  };
};

const verifyMfa = async (email, mfaCode, ipAddress = null) => {
  const found = await findUserForMfa(email);

  if (!found) {
    return { success: false, message: 'Invalid user or MFA code' };
  }

  const user = await getSecurityUser(found.user_id);

  if (
    !user ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    !getAllowedAuthRole(user.role) ||
    !user.is_mfa_active ||
    user.mfa_enrollment_pending
  ) {
    await logAuditSafely({
      userId: found.user_id,
      eventType: 'AUTH_MFA_BLOCKED',
      email,
      ipAddress,
      details: { reason: 'ACCOUNT_UNAVAILABLE_OR_MFA_INACTIVE' }
    });

    return {
      success: false,
      message: 'Account unavailable or MFA is not active'
    };
  }

  let valid = false;

  try {
    valid = (await verify({
      secret: decryptMfaSecret(user.mfa_secret),
      token: String(mfaCode || '')
    })).valid;
  } catch {
    valid = false;
  }

  if (!valid) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_MFA_FAILED',
      email: user.email,
      ipAddress,
      details: { reason: 'INVALID_MFA_CODE' }
    });

    return { success: false, message: 'Invalid MFA code' };
  }

  await resetFailedLoginAttempts(user.user_id);

  const tokens = await createSession(user, ipAddress);

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_LOGIN_SUCCESS',
    email: user.email,
    ipAddress,
    details: { method: 'TOTP' }
  });

  return {
    success: true,
    message: 'Login successful',
    ...tokens,
    tokenType: 'Bearer',
    expiresIn: accessTokenExpiresIn,
    user: {
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id
    }
  };
};

const generateBackupCodes = async userId => {
  const backupCodes = [];
  const hashes = [];

  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(8).toString('hex');
    backupCodes.push(code);
    hashes.push(await bcrypt.hash(code, 12));
  }

  const result = await generateBackupCodesIfAbsent(userId, hashes);

  if (!result.created) {
    return {
      success: false,
      message: result.reason === 'user_not_found'
        ? 'User not found'
        : 'Backup codes already exist. Use your existing codes.'
    };
  }

  await logAuditSafely({
    userId,
    eventType: 'AUTH_BACKUP_CODES_GENERATED',
    details: { count: backupCodes.length }
  });

  return {
    success: true,
    message: 'Save these codes now. They will not be shown again.',
    backupCodes
  };
};

const verifyBackupCode = async (email, password, backupCode, ipAddress = null) => {
  const found = await findUserByEmail(email);

  if (!found) {
    return { success: false, message: 'Invalid credentials or backup code' };
  }

  const user = await getSecurityUser(found.user_id);

  if (
    !user ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    !getAllowedAuthRole(user.role) ||
    !user.is_mfa_active ||
    user.mfa_enrollment_pending
  ) {
    return { success: false, message: 'Account unavailable' };
  }

  if (!await bcrypt.compare(password, user.password_hash)) {
    await recordFailedLogin(user.user_id);
    return { success: false, message: 'Invalid credentials or backup code' };
  }

  const verification = await verifyAndConsumeBackupCode(
    user.user_id,
    backupCode
  );

  if (!verification.success) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_BACKUP_CODE_LOGIN_FAILED',
      email: user.email,
      ipAddress,
      details: { reason: 'INVALID_OR_USED_BACKUP_CODE' }
    });

    return {
      success: false,
      message: 'Invalid or already-used backup code'
    };
  }

  await resetFailedLoginAttempts(user.user_id);

  const tokens = await createSession(user, ipAddress);

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_LOGIN_SUCCESS',
    email: user.email,
    ipAddress,
    details: { method: 'BACKUP_CODE' }
  });

  return {
    success: true,
    message: 'Backup code verified. Login successful.',
    ...tokens,
    tokenType: 'Bearer',
    expiresIn: accessTokenExpiresIn,
    user: {
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id
    }
  };
};

const getUserBackupCodeStatus = async userId => {
  const status = await getBackupCodeStatus(userId);

  return {
    success: true,
    totalCodes: status.total_codes,
    unusedCodes: status.unused_codes,
    usedCodes: status.used_codes
  };
};

const refreshAccessToken = async (refreshToken, ipAddress = null) => {
  try {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('Invalid refresh token');
    }

    const hash = hashRefreshToken(refreshToken);
    const session = await findSessionByRefreshTokenHash(hash);

    if (
      !session ||
      session.revoked ||
      new Date(session.expires_at) <= new Date()
    ) {
      throw new Error('Invalid refresh token');
    }

    const user = await getSecurityUser(session.user_id);

    if (
      !user ||
      isAdminLocked(user) ||
      isTemporarilyLocked(user) ||
      !user.is_mfa_active ||
      user.mfa_enrollment_pending
    ) {
      throw new Error('Account unavailable');
    }

    const newRefreshToken = makeRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const rotated = await rotateRefreshToken(
      session.session_id,
      hash,
      newHash,
      expiresAt,
      ipAddress || session.ip_address || '127.0.0.1'
    );

    if (!rotated) {
      throw new Error('Refresh rotation failed');
    }

    const accessToken = createAccessToken(user);

    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_TOKEN_REFRESHED',
      email: user.email,
      ipAddress,
      details: { result: 'SUCCESS' }
    });

    return {
      success: true,
      message: 'Access token refreshed successfully',
      accessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: accessTokenExpiresIn
    };
  } catch {
    await logAuditSafely({
      eventType: 'AUTH_TOKEN_REFRESH_FAILED',
      ipAddress,
      details: { reason: 'INVALID_OR_EXPIRED_REFRESH_TOKEN' }
    });

    throw new Error('Invalid or expired refresh token');
  }
};

const revokeUserSession = async (refreshToken, ipAddress = null) => {
  try {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return { success: false, message: 'Failed to revoke session' };
    }

    const session = await findSessionByRefreshTokenHash(
      hashRefreshToken(refreshToken)
    );

    if (!session || session.revoked) {
      return {
        success: true,
        message: 'Session revoked successfully. Token invalidated.'
      };
    }

    await revokeSession(session.session_id);

    await logAuditSafely({
      userId: session.user_id,
      eventType: 'AUTH_SESSION_REVOKED',
      ipAddress,
      details: { result: 'SUCCESS' }
    });

    return {
      success: true,
      message: 'Session revoked successfully. Token invalidated.'
    };
  } catch {
    return { success: false, message: 'Failed to revoke session' };
  }
};

module.exports = {
  login,
  verifyMfa,
  generateBackupCodes,
  verifyBackupCode,
  getUserBackupCodeStatus,
  refreshAccessToken,
  revokeUserSession,
  startMfaEnrollment,
  confirmMfaEnrollment,
  createEncryptedMfaSecret
};