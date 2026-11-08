const model = require('./superAdmin.model');
const { createAuditLog } = require('../auth/audit.model');

const ALLOWED_ROLES = [
  'SUPER_ADMIN',
  'CENTER_SUPERINTENDENT',
  'TRADE_TESTER'
];

const MANAGED_ROLES = [
  'CENTER_SUPERINTENDENT',
  'TRADE_TESTER'
];

const DEVICE_ONLINE_THRESHOLD_SECONDS = Number(
  process.env.DEVICE_ONLINE_THRESHOLD_SECONDS || 300
);

if (
  !Number.isInteger(DEVICE_ONLINE_THRESHOLD_SECONDS) ||
  DEVICE_ONLINE_THRESHOLD_SECONDS <= 0
) {
  throw new Error('Invalid DEVICE_ONLINE_THRESHOLD_SECONDS configuration');
}

const createError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

// --------------------------------------------------
// RESPONSE SHAPING
// --------------------------------------------------
// The database returns snake_case columns, but the frontend contract
// (docs/frontend_guide_7.md) is camelCase. Every row is returned with BOTH
// spellings so the portal works whichever one it reads.
const toCamel = (key) =>
  key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

const withCamelKeys = (row) => {
  if (!row || typeof row !== 'object') return row;

  const out = { ...row };

  for (const [key, value] of Object.entries(row)) {
    const camel = toCamel(key);
    if (!(camel in out)) {
      out[camel] = value;
    }
  }

  return out;
};

const mapAuditLog = (row) => ({
  ...withCamelKeys(row),
  logId: row.audit_id
});

// --------------------------------------------------
// AUDIT HELPER
// --------------------------------------------------
const auditAdminAction = async ({
  adminUserId,
  eventType,
  ipAddress,
  details
}) => {
  try {
    await createAuditLog({
      userId: adminUserId,
      eventType,
      ipAddress: ipAddress || null,
      details: details || {}
    });
  } catch (error) {
    // Never log secrets or tokens.
    console.error(`Failed to record audit event: ${eventType}`);
  }
};

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------
const getDashboard = async () => {
  const stats = await model.getDashboardStats();

  return {
    stats,
    message: 'Dashboard statistics retrieved successfully'
  };
};

// --------------------------------------------------
// LIST USERS
// --------------------------------------------------
const getUsers = async (filters = {}) => {
  const limit = Math.min(
    Math.max(Number(filters.limit) || 50, 1),
    100
  );

  const offset = Math.max(
    Number(filters.offset) || 0,
    0
  );

  const role = filters.role || undefined;

  if (role && !ALLOWED_ROLES.includes(role)) {
    throw createError('Invalid role filter');
  }

  const search = filters.search
    ? String(filters.search).trim().slice(0, 100)
    : undefined;

  const [rows, total] = await Promise.all([
    model.listUsers({ limit, offset, role, search }),
    model.countUsers({ role, search })
  ]);

  // Documented shape: { users: [...], pagination: { limit, offset, total } }
  return {
    users: rows.map(withCamelKeys),
    pagination: { limit, offset, total }
  };
};

// --------------------------------------------------
// AUDIT LOGS
// --------------------------------------------------
const getAuditLogs = async (limitValue) => {
  const limit = Math.min(
    Math.max(Number(limitValue) || 50, 1),
    100
  );

  const rows = await model.getRecentAuditLogs(limit);

  return rows.map(mapAuditLog);
};

// --------------------------------------------------
// ACTIVE SESSIONS
// --------------------------------------------------
const getSessions = async (limitValue) => {
  const limit = Math.min(
    Math.max(Number(limitValue) || 100, 1),
    100
  );

  const rows = await model.listActiveSessions(limit);

  return rows.map(withCamelKeys);
};

// --------------------------------------------------
// MINTING QUEUE
// --------------------------------------------------
const getMintingQueue = async (filters = {}) => {
  const limit = Math.min(
    Math.max(Number(filters.limit) || 50, 1),
    100
  );

  const status = filters.status
    ? String(filters.status).trim().toUpperCase()
    : undefined;

  if (
    status &&
    !['QUEUED', 'BROADCASTED', 'CONFIRMED', 'MINTED', 'FAILED'].includes(status)
  ) {
    throw createError('Invalid minting queue status filter');
  }

  const rows = await model.listMintingQueue({ limit, status });

  return rows.map(withCamelKeys);
};

// --------------------------------------------------
// REVOKE SESSION
// --------------------------------------------------
const revokeSession = async ({
  sessionId,
  adminUserId,
  ipAddress
}) => {
  if (!sessionId) {
    throw createError('Session ID is required');
  }

  const session = await model.revokeSessionById(sessionId);

  if (!session) {
    throw createError('Active session not found', 404);
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_SESSION_REVOKED',
    ipAddress,
    details: {
      targetSessionId: session.session_id,
      targetUserId: session.user_id
    }
  });

  return { message: 'Session revoked successfully' };
};

// --------------------------------------------------
// USER DETAILS
// --------------------------------------------------
const getUserDetails = async (userId) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  const user = await model.getUserById(userId);

  if (!user) {
    throw createError('User not found', 404);
  }

  const [sessions, auditRows] = await Promise.all([
    model.listSessionsByUser(userId),
    model.getRecentAuditForUser(userId)
  ]);

  // Documented shape: { user, sessions, recentAuditEvents }
  return {
    user: withCamelKeys(user),
    sessions: sessions.map(withCamelKeys),
    recentAuditEvents: auditRows.map(mapAuditLog)
  };
};

// --------------------------------------------------
// CREATE MANAGED USER
// --------------------------------------------------
const createUser = async ({
  email,
  password,
  role,
  hubLocationId,
  adminUserId,
  ipAddress,
  encryptedMfaSecret
}) => {
  if (typeof email !== 'string' || !email.trim()) {
    throw createError('A valid email is required');
  }

  const normalizedEmail = email.trim().toLowerCase();

  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw createError('Please provide a valid email address');
  }

  if (
    typeof password !== 'string' ||
    password.length < 12 ||
    password.length > 72
  ) {
    throw createError(
      'Password must be between 12 and 72 characters'
    );
  }

  if (!MANAGED_ROLES.includes(role)) {
    throw createError(
      'Only Trade Testers and Center Superintendents can be created here'
    );
  }

  const parsedHubId = Number(hubLocationId);

  if (
    !Number.isSafeInteger(parsedHubId) ||
    parsedHubId <= 0
  ) {
    throw createError(
      'A valid hubLocationId is required for this role'
    );
  }

  if (
    typeof encryptedMfaSecret !== 'string' ||
    !encryptedMfaSecret.trim()
  ) {
    throw createError(
      'An encrypted MFA secret must be generated by the auth service'
    );
  }

  const exists = await model.emailExists(normalizedEmail);

  if (exists) {
    throw createError(
      'An account with this email already exists',
      409
    );
  }

  let user;

  try {
    user = await model.createManagedUser({
      email: normalizedEmail,
      password,
      role,
      hubLocationId: parsedHubId,
      encryptedMfaSecret
    });
  } catch (error) {
    if (error.code === '23505') {
      throw createError(
        'An account with this email already exists',
        409
      );
    }

    if (error.code === '23514' || error.code === '23503') {
      throw createError(
        'The supplied hub location is invalid',
        400
      );
    }

    throw error;
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_USER_CREATED',
    ipAddress,
    details: {
      targetUserId: user.user_id,
      targetEmail: user.email,
      targetRole: user.role,
      hubLocationId: user.hub_location_id
    }
  });

  // Guide #7 shows the new user's fields directly under `data`, so
  // expose them there as well as under `data.user`.
  return {
    ...withCamelKeys(user),
    message: 'User created successfully. MFA enrollment is required.',
    user: withCamelKeys(user)
  };
};

// --------------------------------------------------
// LOCK USER
// --------------------------------------------------
const lockUser = async ({
  userId,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  const target = await model.getSecurityUserById(userId);

  if (!target) {
    throw createError('User not found', 404);
  }

  if (target.role === 'SUPER_ADMIN') {
    throw createError(
      'Super Admin accounts cannot be locked through this endpoint',
      403
    );
  }

  const user = await model.setAdminLock(userId, true);

  if (!user) {
    throw createError('User not found', 404);
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_USER_LOCKED',
    ipAddress,
    details: {
      targetUserId: user.user_id,
      targetEmail: user.email,
      targetRole: user.role
    }
  });

  return {
    message: 'User account locked successfully',
    user: withCamelKeys(user)
  };
};

// --------------------------------------------------
// UNLOCK USER
// --------------------------------------------------
const unlockUser = async ({
  userId,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  const target = await model.getSecurityUserById(userId);

  if (!target) {
    throw createError('User not found', 404);
  }

  if (target.role === 'SUPER_ADMIN') {
    throw createError(
      'Super Admin accounts cannot be unlocked through this endpoint',
      403
    );
  }

  const user = await model.setAdminLock(userId, false);

  if (!user) {
    throw createError('User not found', 404);
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_USER_UNLOCKED',
    ipAddress,
    details: {
      targetUserId: user.user_id,
      targetEmail: user.email,
      targetRole: user.role
    }
  });

  return {
    message: 'User account unlocked successfully',
    user: withCamelKeys(user)
  };
};

// --------------------------------------------------
// RESET USER MFA
// --------------------------------------------------
const resetMfa = async ({
  userId,
  adminUserId,
  ipAddress,
  encryptedMfaSecret
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  if (
    typeof encryptedMfaSecret !== 'string' ||
    !encryptedMfaSecret.trim()
  ) {
    throw createError(
      'A newly generated encrypted MFA secret is required'
    );
  }

  const target = await model.getSecurityUserById(userId);

  if (!target) {
    throw createError('User not found', 404);
  }

  if (target.role === 'SUPER_ADMIN') {
    throw createError(
      'Super Admin MFA cannot be reset through this endpoint',
      403
    );
  }

  const user = await model.resetUserMfa(
    userId,
    encryptedMfaSecret
  );

  if (!user) {
    throw createError('User not found', 404);
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_MFA_RESET',
    ipAddress,
    details: {
      targetUserId: user.user_id,
      targetEmail: user.email,
      targetRole: user.role
    }
  });

  return {
    message: 'MFA reset successfully. The user must enroll MFA again.',
    user
  };
};

// --------------------------------------------------
// DEVICE MANAGEMENT
// --------------------------------------------------

const registerDevice = async ({
  hubLocationId,
  deviceName,
  deviceFingerprint,
  deviceCredentialHash,
  adminUserId,
  ipAddress
}) => {
  const parsedHubId = Number(hubLocationId);

  if (
    !Number.isInteger(parsedHubId) ||
    parsedHubId < 1 ||
    parsedHubId > 5
  ) {
    throw createError('hubLocationId must be between 1 and 5');
  }

  if (
    typeof deviceName !== 'string' ||
    !deviceName.trim() ||
    deviceName.trim().length > 100
  ) {
    throw createError('Device name is required and must not exceed 100 characters');
  }

  if (
    typeof deviceFingerprint !== 'string' ||
    !deviceFingerprint.trim() ||
    deviceFingerprint.trim().length > 255
  ) {
    throw createError('A valid device fingerprint is required');
  }

  if (
    typeof deviceCredentialHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(deviceCredentialHash)
  ) {
    throw createError('A valid device credential hash is required');
  }

  let device;

  try {
    device = await model.registerAuthorizedDevice({
      hubLocationId: parsedHubId,
      deviceName: deviceName.trim(),
      deviceFingerprint: deviceFingerprint.trim().toLowerCase(),
      deviceCredentialHash
    });
  } catch (error) {
    if (error.code === '23505') {
      throw createError(
        'A device with this fingerprint or credential is already registered',
        409
      );
    }

    throw error;
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_DEVICE_REGISTERED',
    ipAddress,
    details: {
      deviceId: device.device_id,
      hubLocationId: device.hub_location_id,
      deviceName: device.device_name
    }
  });

  return {
    message: 'Device registered successfully',
    device
  };
};

const listDevices = async (filters = {}) => {
  const limit = Math.min(
    Math.max(Number(filters.limit) || 50, 1),
    100
  );

  const offset = Math.max(
    Number(filters.offset) || 0,
    0
  );

  let hubLocationId = null;

  if (filters.hubLocationId !== undefined) {
    hubLocationId = Number(filters.hubLocationId);

    if (
      !Number.isInteger(hubLocationId) ||
      hubLocationId < 1 ||
      hubLocationId > 5
    ) {
      throw createError('hubLocationId must be between 1 and 5');
    }
  }

  return model.listAuthorizedDevices({
    hubLocationId,
    limit,
    offset
  });
};

const revokeDevice = async ({
  deviceId,
  adminUserId,
  ipAddress
}) => {
  if (
    typeof deviceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)
  ) {
    throw createError('Invalid device ID format');
  }

  const device = await model.revokeAuthorizedDevice(deviceId);

  if (!device) {
    throw createError('Active device not found', 404);
  }

  await auditAdminAction({
    adminUserId,
    eventType: 'SUPER_ADMIN_DEVICE_REVOKED',
    ipAddress,
    details: {
      deviceId: device.device_id,
      hubLocationId: device.hub_location_id,
      deviceName: device.device_name
    }
  });

  return {
    message: 'Device revoked and associated sessions invalidated',
    device
  };
};

const getDeviceHealth = async (hubLocationIdValue) => {
  let hubLocationId = null;

  if (
    hubLocationIdValue !== undefined &&
    hubLocationIdValue !== null &&
    hubLocationIdValue !== ''
  ) {
    hubLocationId = Number(hubLocationIdValue);

    if (
      !Number.isInteger(hubLocationId) ||
      hubLocationId < 1 ||
      hubLocationId > 5
    ) {
      throw createError('hubLocationId must be between 1 and 5');
    }
  }

  const devices = await model.getDeviceHealth(hubLocationId);

  const devicesWithStatus = devices.map((device) => {
    const lastHeartbeat = device.last_heartbeat_at
      ? new Date(device.last_heartbeat_at).getTime()
      : null;

    const online =
      lastHeartbeat !== null &&
      Date.now() - lastHeartbeat <=
        DEVICE_ONLINE_THRESHOLD_SECONDS * 1000;

    return {
      ...device,
      status: online && !device.revoked ? 'online' : 'offline'
    };
  });

  return devicesWithStatus;
};

// --------------------------------------------------
// HUB DEVICE LOCKDOWN
// --------------------------------------------------
const setHubLockdown = async ({
  hubLocationId,
  isLocked,
  adminUserId,
  ipAddress
}) => {
  const parsedHubId = Number(hubLocationId);

  if (
    !Number.isInteger(parsedHubId) ||
    parsedHubId < 1 ||
    parsedHubId > 5
  ) {
    throw createError('hubLocationId must be between 1 and 5');
  }

  if (typeof isLocked !== 'boolean') {
    throw createError('isLocked must be a boolean');
  }

  const lockdown = await model.setHubLockdown(
    parsedHubId,
    isLocked,
    adminUserId
  );

  await auditAdminAction({
    adminUserId,
    eventType: isLocked
      ? 'SUPER_ADMIN_HUB_LOCKDOWN_ENABLED'
      : 'SUPER_ADMIN_HUB_LOCKDOWN_DISABLED',
    ipAddress,
    details: {
      hubLocationId: parsedHubId,
      isLocked
    }
  });

  return {
    message: isLocked
      ? 'Hub lockdown enabled'
      : 'Hub lockdown disabled',
    lockdown
  };
};

// --------------------------------------------------
// B4: CHANGE USER ROLE
// --------------------------------------------------

const changeUserRole = async ({
  userId,
  role,
  hubLocationId,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  if (!ALLOWED_ROLES.includes(role)) {
    throw createError('Invalid user role');
  }

  let parsedHubId = null;

  if (role !== 'SUPER_ADMIN') {
    parsedHubId = Number(hubLocationId);

    if (
      !Number.isInteger(parsedHubId) ||
      parsedHubId < 1 ||
      parsedHubId > 5
    ) {
      throw createError('A valid hubLocationId between 1 and 5 is required');
    }
  } else if (hubLocationId !== undefined && hubLocationId !== null && hubLocationId !== '') {
    parsedHubId = Number(hubLocationId);

    if (
      !Number.isInteger(parsedHubId) ||
      parsedHubId < 1 ||
      parsedHubId > 5
    ) {
      throw createError('hubLocationId must be between 1 and 5 or null');
    }
  }

  if (userId === adminUserId) {
    throw createError('You cannot change your own role', 403);
  }

  const result = await model.changeUserRole(
    userId,
    role,
    parsedHubId,
    adminUserId,
    ipAddress
  );

  if (!result) {
    throw createError('User not found', 404);
  }

  return {
    message: 'User role updated successfully. Existing sessions were revoked.',
    user: result.user
  };
};

// --------------------------------------------------
// B4: REASSIGN USER HUB
// --------------------------------------------------

const reassignUserHub = async ({
  userId,
  hubLocationId,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  const parsedHubId = Number(hubLocationId);

  if (
    !Number.isInteger(parsedHubId) ||
    parsedHubId < 1 ||
    parsedHubId > 5
  ) {
    throw createError('hubLocationId must be between 1 and 5');
  }

  const target = await model.getSecurityUserById(userId);

  if (!target) {
    throw createError('User not found', 404);
  }

  if (!['TRADE_TESTER', 'CENTER_SUPERINTENDENT'].includes(target.role)) {
    throw createError('Only hub-scoped users can be reassigned', 400);
  }

  const user = await model.reassignUserHub(
    userId,
    parsedHubId,
    adminUserId,
    ipAddress
  );

  if (!user) {
    throw createError('Hub reassignment could not be completed', 404);
  }

  return {
    message: 'User hub reassigned successfully. Existing sessions were revoked.',
    user
  };
};

// --------------------------------------------------
// B4: DEACTIVATE / REACTIVATE USER
// --------------------------------------------------

const setUserActiveStatus = async ({
  userId,
  isActive,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  if (typeof isActive !== 'boolean') {
    throw createError('isActive must be a boolean');
  }

  if (userId === adminUserId && !isActive) {
    throw createError('You cannot deactivate your own account', 403);
  }

  const result = await model.setUserActiveStatus(
    userId,
    isActive,
    adminUserId,
    ipAddress
  );

  if (!result) {
    throw createError('User not found', 404);
  }

  return {
    message: isActive
      ? 'User account reactivated successfully'
      : 'User account deactivated successfully',
    user: result.user
  };
};

// --------------------------------------------------
// B4: ADMIN PASSWORD RESET
// --------------------------------------------------

const resetUserPassword = async ({
  userId,
  newPassword,
  adminUserId,
  ipAddress
}) => {
  if (!userId) {
    throw createError('User ID is required');
  }

  if (
    typeof newPassword !== 'string' ||
    Buffer.byteLength(newPassword, 'utf8') < 12 ||
    Buffer.byteLength(newPassword, 'utf8') > 72
  ) {
    throw createError('Password must be between 12 and 72 bytes long');
  }

  if (userId === adminUserId) {
    throw createError(
      'Use the normal password-change flow to change your own password',
      403
    );
  }

  const user = await model.resetUserPassword(
    userId,
    newPassword,
    adminUserId,
    ipAddress
  );

  if (!user) {
    throw createError('User not found', 404);
  }

  return {
    message: 'User password reset successfully. Existing sessions were revoked.',
    user
  };
};

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------
module.exports = {
  getDashboard,
  getUsers,
  getAuditLogs,
  getSessions,
  getMintingQueue,
  revokeSession,
  getUserDetails,
  createUser,
  lockUser,
  unlockUser,
  resetMfa,
  registerDevice,
  listDevices,
  revokeDevice,
  getDeviceHealth,
  setHubLockdown,
  changeUserRole,
  reassignUserHub,
  setUserActiveStatus,
  resetUserPassword
};