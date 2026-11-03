const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify, generateSecret, generateURI } = require('otplib');
const {
  encryptMfaSecret,
  createEncryptedMfaSecret
} = require('./mfaSecret');
const pool = require('../../config/db');
const { privateKey, accessTokenExpiresIn } = require('../../config/jwt');
const { createAuditLog } = require('./audit.model');

const {
  findUserByEmail,
  findUserForMfa,
  findSessionByRefreshTokenHash,
  findRefreshTokenHistory,
  findUserById,
  findUserPasswordById,
  findUserProfileById,
  updatePasswordAndRevokeSessions,
  listUserSessions,
  revokeSession,
  revokeSessionFamily,
  rotateRefreshToken,
  recordFailedLogin,
  resetFailedLoginAttempts,
  recordFailedMfa,
  resetFailedMfa
} = require('./auth.model');

const {
  generateBackupCodesIfAbsent,
  verifyAndConsumeBackupCode,
  getBackupCodeStatus
} = require('./backupCode.model');

// ======================================================
// ROLE GUARD
// ======================================================
const getAllowedAuthRole = role =>
  ['TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'].includes(role);

// ======================================================
// AUDIT HELPER — never throws
// ======================================================
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

// ======================================================
// MFA SECRET ENCRYPTION / DECRYPTION
// ======================================================
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

// ======================================================
// TOKEN + SESSION HELPERS
// ======================================================

/**
 * Build a signed access token.
 * Includes tokenVersion and sid so the middleware can detect invalidated tokens/sessions.
 */
const createAccessToken = (user, sessionId) => {
  if (!sessionId) {
    throw new Error('Session ID is missing');
  }

  if (!Number.isInteger(Number(user.token_version))) {
    throw new Error('User token version is missing');
  }

  return jwt.sign(
    {
      sub: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id,
      tokenVersion: Number(user.token_version),
      sid: sessionId
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: accessTokenExpiresIn
    }
  );
};

/**
 * Fetch a user row that includes all security-critical columns
 * (admin_locked, token_version, mfa_enrollment_pending, etc.).
 */
const getSecurityUser = async userId => {
  const result = await pool.query(
    `SELECT user_id, email, role, hub_location_id,
            is_active, password_hash, mfa_secret, is_mfa_active,
            mfa_enrollment_pending, admin_locked,
            token_version, failed_login_attempts, locked_until,
            failed_mfa_attempts, mfa_locked_until
       FROM auth.users
      WHERE user_id = $1`,
    [userId]
  );

  return result.rows[0] || null;
};

const isTemporarilyLocked = user =>
  user.locked_until && new Date(user.locked_until) > new Date();

const isMfaLocked = user =>
  user.mfa_locked_until &&
  new Date(user.mfa_locked_until) > new Date();

const isAdminLocked = user => user.admin_locked === true;

const isAccountInactive = user => user.is_active === false;

const makeRefreshToken = () => crypto.randomBytes(40).toString('hex');

const hashRefreshToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

// ======================================================
// DEVICE FINGERPRINT RESOLVER (FR-AUTH-04)
// ======================================================
/**
 * Resolve a canonical fingerprint string for binding to sessions.
 * If the caller supplied a fingerprint header, use it; otherwise
 * derive a deterministic fallback from the IP so every session
 * always has a non-null fingerprint stored.
 */
const resolveFingerprint = (deviceFingerprint, ipAddress = null) => {
  if (
    deviceFingerprint &&
    typeof deviceFingerprint === 'string' &&
    deviceFingerprint.trim().length > 0
  ) {
    return deviceFingerprint.trim().toLowerCase();
  }

  const ip = ipAddress || '127.0.0.1';

  return crypto
    .createHash('sha256')
    .update(`fallback-ua|${ip}`)
    .digest('hex');
};

// ======================================================
// B3: AUTHORIZED DEVICE CHECK
// ======================================================
const authorizeHubDevice = async ({
  user,
  ipAddress = null,
  deviceFingerprint = null,
  deviceCredential = null,
  action = 'LOGIN'
}) => {
  if (!user) {
    return {
      allowed: false,
      statusCode: 403,
      message: 'Account unavailable.'
    };
  }

  // Super Admin accounts are not assigned to a testing hub.
  if (user.role === 'SUPER_ADMIN') {
    return { allowed: true, reason: 'SUPER_ADMIN_EXEMPT' };
  }

  const mode = String(
    process.env.DEVICE_ENFORCEMENT || 'audit'
  ).trim().toLowerCase();

  if (!['audit', 'warn', 'enforce'].includes(mode)) {
    throw new Error('Invalid DEVICE_ENFORCEMENT configuration');
  }

  const hubLocationId = user.hub_location_id;
  const fingerprint = resolveFingerprint(
    deviceFingerprint,
    ipAddress
  );

  const credentialHash =
    typeof deviceCredential === 'string' &&
    deviceCredential.trim().length > 0
      ? crypto
          .createHash('sha256')
          .update(deviceCredential.trim())
          .digest('hex')
      : null;

  // Check whether the hub is locked down.
  const lockdown = await pool.query(
    `SELECT is_locked
       FROM auth.hub_device_lockdowns
      WHERE hub_location_id = $1`,
    [hubLocationId]
  );

  if (lockdown.rows[0]?.is_locked === true) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_DEVICE_BLOCKED',
      email: user.email,
      ipAddress,
      details: {
        reason: 'HUB_LOCKDOWN',
        hubLocationId,
        action
      }
    });

    return {
      allowed: false,
      statusCode: 403,
      message: 'Access from this hub is currently locked down.'
    };
  }

  // Find a device using its fingerprint or credential hash.
  const deviceResult = await pool.query(
    `SELECT device_id,
            device_fingerprint,
            device_credential_hash,
            edr_status,
            revoked
       FROM auth.authorized_devices
      WHERE hub_location_id = $1
        AND (
          device_fingerprint = $2
          OR (
            $3::VARCHAR IS NOT NULL
            AND device_credential_hash = $3
          )
        )`,
    [hubLocationId, fingerprint, credentialHash]
  );

  const fingerprintDevice =
    deviceResult.rows.find(
      device => device.device_fingerprint === fingerprint
    ) || null;

  const credentialDevice = credentialHash
    ? deviceResult.rows.find(
        device => device.device_credential_hash === credentialHash
      ) || null
    : null;

  // Revocation always blocks, regardless of enforcement mode.
  if (
    fingerprintDevice?.revoked === true ||
    credentialDevice?.revoked === true
  ) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_DEVICE_BLOCKED',
      email: user.email,
      ipAddress,
      details: {
        reason: 'DEVICE_REVOKED',
        hubLocationId,
        action
      }
    });

    return {
      allowed: false,
      statusCode: 403,
      message: 'This device has been revoked.'
    };
  }

  // Both identifiers must refer to the same registered device.
  const authorized =
    Boolean(fingerprintDevice) &&
    Boolean(credentialDevice) &&
    fingerprintDevice.device_id === credentialDevice.device_id;

  const edrCompliant =
    fingerprintDevice?.edr_status === 'compliant';

  if (authorized && edrCompliant) {
    return {
      allowed: true,
      reason: 'AUTHORIZED_DEVICE',
      deviceId: fingerprintDevice.device_id
    };
  }

  const reason = !fingerprintDevice
    ? 'DEVICE_NOT_REGISTERED'
    : !credentialDevice
      ? 'INVALID_DEVICE_CREDENTIAL'
      : !authorized
        ? 'DEVICE_FINGERPRINT_MISMATCH'
        : 'EDR_NOT_COMPLIANT';

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_DEVICE_AUTHORIZATION_WARNING',
    email: user.email,
    ipAddress,
    details: {
      reason,
      mode,
      hubLocationId,
      action
    }
  });

  if (mode === 'enforce') {
    return {
      allowed: false,
      statusCode: 403,
      message: 'This device is not authorized for this hub.'
    };
  }

  return {
    allowed: true,
    reason,
    warning: mode === 'warn'
  };
};

/**
 * Insert a new session row and return fresh token pair.
 * deviceFingerprint is stored so refresh-token rotation can
 * detect device switches (Phase 1 — audit only).
 */
const createSession = async (user, ipAddress, deviceFingerprint = null) => {
  const refreshToken = makeRefreshToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const resolvedFingerprint = resolveFingerprint(
    deviceFingerprint,
    ipAddress
  );

  const result = await pool.query(
    `INSERT INTO auth.sessions
        (user_id, refresh_token_hash, ip_address, device_fingerprint, expires_at, revoked)
     VALUES ($1, $2, $3, $4, $5, FALSE)
     RETURNING session_id`,
    [
      user.user_id,
      hashRefreshToken(refreshToken),
      ipAddress || '127.0.0.1',
      resolvedFingerprint,
      expiresAt
    ]
  );

  const sessionId = result.rows[0].session_id;

  return {
    accessToken: createAccessToken(user, sessionId),
    refreshToken
  };
};

// ======================================================
// LOGIN: EMAIL + PASSWORD + ACCOUNT LOCKOUT
// ======================================================
const login = async (
  email,
  password,
  ipAddress = null,
  deviceFingerprint = null,
  deviceCredential = null
) => {
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

  const user = await getSecurityUser(foundUser.user_id);

  if (!user) {
    return { success: false, message: 'Invalid email or password' };
  }

  if (
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user)
  ) {
    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_LOGIN_BLOCKED',
      email: user.email,
      ipAddress,
      details: {
        reason: isAccountInactive(user)
          ? 'ACCOUNT_INACTIVE'
          : isAdminLocked(user)
            ? 'ADMIN_LOCKED'
            : 'TEMPORARY_LOCKOUT'
      }
    });

    return {
      success: false,
      message: isAccountInactive(user)
        ? 'Account is inactive'
        : 'Account is locked'
    };
  }

  const passwordMatches = await bcrypt.compare(
    password,
    user.password_hash
  );

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
      message:
        failed && failed.failed_login_attempts >= 5
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
        expiresIn: '15m'
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

// ======================================================
// START MFA ENROLLMENT
// ======================================================
const startMfaEnrollment = async (userId, ipAddress = null) => {
  const user = await getSecurityUser(userId);

  if (
    !user ||
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user)
  ) {
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

// ======================================================
// CONFIRM MFA ENROLLMENT
// ======================================================
const confirmMfaEnrollment = async (
  userId,
  code,
  ipAddress = null
) => {
  const user = await getSecurityUser(userId);

  if (
    !user ||
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    !user.mfa_enrollment_pending
  ) {
    return {
      success: false,
      message: 'MFA enrollment is not pending'
    };
  }

  let result;

  try {
    const secret = decryptMfaSecret(user.mfa_secret);

    result = await verify({
      secret,
      token: String(code || '').trim()
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

    return {
      success: false,
      message: 'Invalid MFA code'
    };
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

// ======================================================
// VERIFY MFA DURING LOGIN
// ======================================================
const verifyMfa = async (
  email,
  mfaCode,
  ipAddress = null,
  deviceFingerprint = null,
  deviceCredential = null
) => {
  const found = await findUserForMfa(email);

  if (!found) {
    return {
      success: false,
      message: 'Invalid user or MFA code'
    };
  }

  const user = await getSecurityUser(found.user_id);

  if (
    !user ||
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    isMfaLocked(user) ||
    !getAllowedAuthRole(user.role) ||
    !user.is_mfa_active ||
    user.mfa_enrollment_pending
  ) {
    await logAuditSafely({
      userId: found.user_id,
      eventType: 'AUTH_MFA_BLOCKED',
      email,
      ipAddress,
      details: {
        reason: 'ACCOUNT_UNAVAILABLE_OR_MFA_INACTIVE'
      }
    });

    return {
      success: false,
      message: 'Account unavailable or MFA is not active'
    };
  }

  let valid = false;

  try {
    valid = (
      await verify({
        secret: decryptMfaSecret(user.mfa_secret),
        token: String(mfaCode || '').trim()
      })
    ).valid;
  } catch (error) {
    console.error('[MFA VERIFY ERROR]', error.message);
    valid = false;
  }

  if (!valid) {
    const failed = await recordFailedMfa(user.user_id);

    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_MFA_FAILED',
      email: user.email,
      ipAddress,
      details: {
        reason: 'INVALID_MFA_CODE',
        failedMfaAttempts: failed?.failed_mfa_attempts ?? null
      }
    });

    return {
      success: false,
      message:
        failed && failed.failed_mfa_attempts >= 5
          ? 'MFA locked for 15 minutes due to too many failed attempts.'
          : 'Invalid MFA code'
    };
  }

  const deviceCheck = await authorizeHubDevice({
    user,
    ipAddress,
    deviceFingerprint,
    deviceCredential,
    action: 'LOGIN_TOTP'
  });

  if (!deviceCheck.allowed) {
    return {
      success: false,
      message: deviceCheck.message,
      statusCode: deviceCheck.statusCode || 403
    };
  }

  await resetFailedLoginAttempts(user.user_id);
  await resetFailedMfa(user.user_id);

  const tokens = await createSession(
    user,
    ipAddress,
    deviceFingerprint
  );

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_LOGIN_SUCCESS',
    email: user.email,
    ipAddress,
    details: {
      method: 'TOTP',
      deviceFingerprint: resolveFingerprint(
        deviceFingerprint,
        ipAddress
      )
    }
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

// ======================================================
// GENERATE BACKUP CODES
// ======================================================
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
      message:
        result.reason === 'user_not_found'
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

// ======================================================
// VERIFY BACKUP CODE DURING LOGIN
// ======================================================
const verifyBackupCode = async (
  email,
  password,
  backupCode,
  ipAddress = null,
  deviceFingerprint = null,
  deviceCredential = null
) => {
  const found = await findUserByEmail(email);

  if (!found) {
    return {
      success: false,
      message: 'Invalid credentials or backup code'
    };
  }

  const user = await getSecurityUser(found.user_id);

  if (
    !user ||
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    !getAllowedAuthRole(user.role) ||
    !user.is_mfa_active ||
    user.mfa_enrollment_pending
  ) {
    return {
      success: false,
      message: 'Account unavailable'
    };
  }

  if (!await bcrypt.compare(password, user.password_hash)) {
    await recordFailedLogin(user.user_id);

    return {
      success: false,
      message: 'Invalid credentials or backup code'
    };
  }

  const deviceCheck = await authorizeHubDevice({
    user,
    ipAddress,
    deviceFingerprint,
    deviceCredential,
    action: 'LOGIN_BACKUP_CODE'
  });

  if (!deviceCheck.allowed) {
    return {
      success: false,
      message: deviceCheck.message,
      statusCode: deviceCheck.statusCode || 403
    };
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
      details: {
        reason: 'INVALID_OR_USED_BACKUP_CODE'
      }
    });

    return {
      success: false,
      message: 'Invalid or already-used backup code'
    };
  }

  await resetFailedLoginAttempts(user.user_id);

  const tokens = await createSession(
    user,
    ipAddress,
    deviceFingerprint
  );

  const resolvedFingerprint = resolveFingerprint(
    deviceFingerprint,
    ipAddress
  );

  await logAuditSafely({
    userId: user.user_id,
    eventType: 'AUTH_LOGIN_SUCCESS',
    email: user.email,
    ipAddress,
    details: {
      method: 'BACKUP_CODE',
      deviceFingerprint: resolvedFingerprint
    }
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

// ======================================================
// STEP-UP MFA TOKEN (B1)
// ======================================================
const createStepUpToken = async ({
  userId,
  sessionId,
  scope,
  mfaCode,
  backupCode,
  ipAddress = null
}) => {
  const allowedScopes = [
    'APPROVE_ASSESSMENT',
    'REVOKE_CREDENTIAL',
    'REGISTER_HUB_KEY',
    'CHANGE_ROLE',
    'RESET_MFA',
    'REASSIGN_HUB',
    'MANAGE_ACCOUNT_STATUS',
    'ADMIN_PASSWORD_RESET'
  ];

  if (!allowedScopes.includes(scope)) {
    return {
      success: false,
      message: 'Invalid step-up scope'
    };
  }

  const hasMfaCode =
    typeof mfaCode === 'string' && mfaCode.trim().length > 0;

  const hasBackupCode =
    typeof backupCode === 'string' && backupCode.trim().length > 0;

  if (hasMfaCode === hasBackupCode) {
    return {
      success: false,
      message: 'Provide exactly one MFA code or backup code'
    };
  }

  const user = await getSecurityUser(userId);

  if (
    !user ||
    isAccountInactive(user) ||
    isAdminLocked(user) ||
    isTemporarilyLocked(user) ||
    isMfaLocked(user) ||
    !user.is_mfa_active ||
    user.mfa_enrollment_pending
  ) {
    return {
      success: false,
      message: 'Account unavailable or MFA is not active'
    };
  }

  let valid = false;
  let verificationMethod = null;

  if (hasMfaCode) {
    verificationMethod = 'TOTP';

    try {
      valid = (
        await verify({
          secret: decryptMfaSecret(user.mfa_secret),
          token: mfaCode.trim()
        })
      ).valid;
    } catch (error) {
      valid = false;
    }
  } else {
    verificationMethod = 'BACKUP_CODE';

    const result = await verifyAndConsumeBackupCode(
      userId,
      backupCode.trim()
    );

    valid = result.success;
  }

  if (!valid) {
    const failed = await recordFailedMfa(userId);

    await logAuditSafely({
      userId,
      eventType: 'AUTH_STEP_UP_FAILED',
      email: user.email,
      ipAddress,
      details: {
        scope,
        method: verificationMethod,
        failedMfaAttempts: failed?.failed_mfa_attempts ?? null
      }
    });

    return {
      success: false,
      message:
        failed && failed.failed_mfa_attempts >= 5
          ? 'MFA locked for 15 minutes due to too many failed attempts.'
          : 'Invalid MFA code'
    };
  }

  await resetFailedMfa(userId);

  const stepUpToken = jwt.sign(
    {
      sub: userId,
      sid: sessionId,
      scope,
      purpose: 'step_up',
      jti: crypto.randomUUID()
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: '5m'
    }
  );

  const decodedToken = jwt.decode(stepUpToken);

  const tokenHash = crypto
    .createHash('sha256')
    .update(stepUpToken)
    .digest('hex');

  await pool.query(
    `
    INSERT INTO auth.step_up_tokens (
      token_hash,
      user_id,
      session_id,
      scope,
      expires_at
    )
    VALUES ($1, $2, $3, $4, to_timestamp($5))
    `,
    [
      tokenHash,
      userId,
      sessionId,
      scope,
      decodedToken.exp
    ]
  );

  await logAuditSafely({
    userId,
    eventType: 'AUTH_STEP_UP_SUCCESS',
    email: user.email,
    ipAddress,
    details: {
      scope,
      method: verificationMethod
    }
  });

  return {
    success: true,
    message: 'Step-up authentication successful',
    stepUpToken,
    tokenType: 'Bearer',
    expiresIn: 300
  };
};

// ======================================================
// BACKUP CODE STATUS
// ======================================================
const getUserBackupCodeStatus = async userId => {
  const status = await getBackupCodeStatus(userId);

  return {
    success: true,
    totalCodes: status.total_codes,
    unusedCodes: status.unused_codes,
    usedCodes: status.used_codes
  };
};

// ======================================================
// REFRESH ACCESS TOKEN + ROTATE REFRESH TOKEN
// Phase 1 device fingerprint check (FR-AUTH-04):
// Logs AUTH_DEVICE_MISMATCH on fingerprint change but does
// NOT reject the session (non-disruptive audit-only mode).
// ======================================================
const refreshAccessToken = async (
  refreshToken,
  ipAddress = null,
  deviceFingerprint = null,
  deviceCredential = null
) => {
  let auditUser = null;

  try {
    if (
      typeof refreshToken !== 'string' ||
      refreshToken.length === 0
    ) {
      throw new Error('Invalid refresh token');
    }

    const hash = hashRefreshToken(refreshToken);

    const session = await findSessionByRefreshTokenHash(hash);

    // Token is not current: check whether it was previously rotated.
    if (!session) {
      const history = await findRefreshTokenHistory(hash);

      if (history) {
        await revokeSessionFamily(history.session_id);

        await logAuditSafely({
          userId: history.user_id,
          eventType: 'AUTH_REFRESH_TOKEN_REUSE_DETECTED',
          ipAddress,
          details: {
            sessionId: history.session_id,
            action: 'SESSION_FAMILY_REVOKED'
          }
        });
      }

      throw new Error('Invalid or expired refresh token');
    }

    if (
      session.revoked ||
      new Date(session.expires_at) <= new Date()
    ) {
      throw new Error('Invalid or expired refresh token');
    }

    const user = await getSecurityUser(session.user_id);

    if (
      !user ||
      isAccountInactive(user) ||
      isAdminLocked(user) ||
      isTemporarilyLocked(user) ||
      !user.is_mfa_active ||
      user.mfa_enrollment_pending
    ) {
      throw new Error('Account unavailable');
    }

    auditUser = user;

    const deviceCheck = await authorizeHubDevice({
      user,
      ipAddress,
      deviceFingerprint,
      deviceCredential,
      action: 'REFRESH'
    });

    if (!deviceCheck.allowed) {
      const deviceError = new Error(deviceCheck.message);
      deviceError.statusCode = deviceCheck.statusCode || 403;
      deviceError.code = 'DEVICE_AUTHORIZATION_DENIED';
      throw deviceError;
    }

    const resolvedFingerprint = resolveFingerprint(
      deviceFingerprint,
      ipAddress
    );

    if (
      session.device_fingerprint &&
      session.device_fingerprint !== resolvedFingerprint
    ) {
      await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_DEVICE_MISMATCH',
        email: user.email,
        ipAddress,
        details: {
          storedFingerprint: session.device_fingerprint,
          incomingFingerprint: resolvedFingerprint,
          mode: 'PHASE_1_AUDIT_ONLY',
          action: 'ALLOWED'
        }
      });
    }

    const newRefreshToken = makeRefreshToken();
    const newHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    const rotated = await rotateRefreshToken(
      session.session_id,
      hash,
      newHash,
      expiresAt,
      ipAddress || session.ip_address || '127.0.0.1',
      resolvedFingerprint
    );

    if (!rotated) {
      // Another concurrent request may have rotated this token.
      const history = await findRefreshTokenHistory(hash);

      if (history) {
        await revokeSessionFamily(history.session_id);

        await logAuditSafely({
          userId: history.user_id,
          eventType: 'AUTH_REFRESH_TOKEN_REUSE_DETECTED',
          ipAddress,
          details: {
            sessionId: history.session_id,
            action: 'SESSION_FAMILY_REVOKED',
            reason: 'CONCURRENT_REFRESH'
          }
        });
      }

      throw new Error('Refresh token rotation failed');
    }

    const accessToken = createAccessToken(
      user,
      session.session_id
    );

    await logAuditSafely({
      userId: user.user_id,
      eventType: 'AUTH_TOKEN_REFRESHED',
      email: user.email,
      ipAddress,
      details: {
        result: 'SUCCESS',
        deviceFingerprint: resolvedFingerprint
      }
    });

    return {
      success: true,
      message: 'Access token refreshed successfully',
      accessToken,
      refreshToken: newRefreshToken,
      tokenType: 'Bearer',
      expiresIn: accessTokenExpiresIn
    };
  } catch (error) {
    await logAuditSafely({
      userId: auditUser ? auditUser.user_id : null,
      eventType: 'AUTH_TOKEN_REFRESH_FAILED',
      email: auditUser ? auditUser.email : null,
      ipAddress,
      details: {
        reason: 'INVALID_OR_EXPIRED_REFRESH_TOKEN'
      }
    });

    if (error.code === 'DEVICE_AUTHORIZATION_DENIED') {
      throw error;
    }

    throw new Error('Invalid or expired refresh token');
  }
};

// ======================================================
// REVOKE SESSION
// ======================================================
const revokeUserSession = async (
  refreshToken,
  ipAddress = null
) => {
  try {
    if (
      typeof refreshToken !== 'string' ||
      refreshToken.length === 0
    ) {
      await logAuditSafely({
        eventType: 'AUTH_SESSION_REVOCATION_FAILED',
        ipAddress,
        details: {
          reason: 'MISSING_REFRESH_TOKEN'
        }
      });

      return {
        success: false,
        message: 'Failed to revoke session'
      };
    }

    const session = await findSessionByRefreshTokenHash(
      hashRefreshToken(refreshToken)
    );

    if (!session) {
      await logAuditSafely({
        eventType: 'AUTH_SESSION_REVOCATION_FAILED',
        ipAddress,
        details: {
          reason: 'SESSION_NOT_FOUND_OR_INVALID'
        }
      });

      return {
        success: true,
        message: 'Session revoked successfully. Token invalidated.'
      };
    }

    if (session.revoked) {
      await logAuditSafely({
        userId: session.user_id,
        eventType: 'AUTH_SESSION_REVOCATION_FAILED',
        ipAddress,
        details: {
          reason: 'SESSION_ALREADY_REVOKED'
        }
      });

      return {
        success: true,
        message: 'Session revoked successfully. Token invalidated.'
      };
    }

    await revokeSession(session.session_id);

    const user = await findUserById(session.user_id);

    await logAuditSafely({
      userId: session.user_id,
      eventType: 'AUTH_SESSION_REVOKED',
      email: user ? user.email : null,
      ipAddress,
      details: {
        result: 'SUCCESS'
      }
    });

    return {
      success: true,
      message: 'Session revoked successfully. Token invalidated.'
    };
  } catch (error) {
    await logAuditSafely({
      eventType: 'AUTH_SESSION_REVOCATION_FAILED',
      ipAddress,
      details: {
        reason: 'REVOCATION_OPERATION_FAILED'
      }
    });

    console.error(
      '[AUTH] Session revocation failed:',
      error.message
    );

    return {
      success: false,
      message: 'Failed to revoke session'
    };
  }
};

// ======================================================
// B2: GET USER PROFILE
// ======================================================
const getUserProfile = async (userId) => {
  return findUserProfileById(userId);
};

// ======================================================
// B2: UPDATE PROFILE — PASSWORD ONLY
// ======================================================
const updateUserProfilePassword = async (
  userId,
  currentPassword,
  newPassword,
  ipAddress
) => {
  const user = await findUserPasswordById(userId);

  if (!user) {
    return {
      success: false,
      message: 'User not found'
    };
  }

  const currentPasswordMatches = await bcrypt.compare(
    currentPassword,
    user.password_hash
  );

  if (!currentPasswordMatches) {
    await logAuditSafely({
      userId,
      eventType: 'AUTH_PASSWORD_CHANGE_FAILED',
      email: user.email,
      ipAddress,
      details: { reason: 'INVALID_CURRENT_PASSWORD' }
    });

    return {
      success: false,
      message: 'Current password is incorrect'
    };
  }

  const samePassword = await bcrypt.compare(
    newPassword,
    user.password_hash
  );

  if (samePassword) {
    return {
      success: false,
      message: 'New password must be different from the current password'
    };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const updatedUser = await updatePasswordAndRevokeSessions(
    userId,
    passwordHash
  );

  if (!updatedUser) {
    return {
      success: false,
      message: 'Unable to update password'
    };
  }

  await logAuditSafely({
    userId,
    eventType: 'AUTH_PASSWORD_CHANGED',
    email: updatedUser.email,
    ipAddress,
    details: { sessionsRevoked: true }
  });

  return {
    success: true,
    message: 'Password updated successfully. Please log in again.'
  };
};

// ======================================================
// B2: LIST AUTHENTICATED USER'S SESSIONS
// ======================================================
const getUserSessions = async (userId, currentSessionId) => {
  const sessions = await listUserSessions(userId);

  return sessions.map(session => ({
    ...session,
    is_current: session.session_id === currentSessionId
  }));
};

// ======================================================
// DEVICE HEARTBEAT (EDR STATUS UPDATE)
// ======================================================
async function updateDeviceHeartbeat(deviceId, edrStatus) {
  const allowedStatuses = ['unknown', 'compliant', 'non_compliant'];

  if (!allowedStatuses.includes(edrStatus)) {
    const error = new Error('Invalid EDR status');
    error.statusCode = 400;
    throw error;
  }

  const result = await pool.query(
    `UPDATE auth.authorized_devices
     SET edr_status = $2,
         last_heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE device_id = $1
       AND revoked = FALSE
     RETURNING
       device_id,
       hub_location_id,
       device_name,
       edr_status,
       last_heartbeat_at`,
    [deviceId, edrStatus]
  );

  if (result.rowCount === 0) {
    const error = new Error('Device not found or revoked');
    error.statusCode = 403;
    throw error;
  }

  return result.rows[0];
}

// ======================================================
// EXPORTS
// ======================================================
module.exports = {
  authorizeHubDevice,
  login,
  verifyMfa,
  generateBackupCodes,
  verifyBackupCode,
  getUserBackupCodeStatus,
  refreshAccessToken,
  revokeUserSession,
  startMfaEnrollment,
  confirmMfaEnrollment,
  createEncryptedMfaSecret,
  createStepUpToken,
  getUserProfile,
  updateUserProfilePassword,
  getUserSessions,
  updateDeviceHeartbeat
};