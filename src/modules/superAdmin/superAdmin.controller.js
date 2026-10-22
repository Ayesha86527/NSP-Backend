const service = require('./superAdmin.service');
const authService = require('../auth/auth.service');

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------
const getDashboard = async (req, res, next) => {
  try {
    const data = await service.getDashboard();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// LIST USERS
// --------------------------------------------------
const getUsers = async (req, res, next) => {
  try {
    const data = await service.getUsers(req.query);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// GET USER DETAILS
// --------------------------------------------------
const getUserDetails = async (req, res, next) => {
  try {
    const data = await service.getUserDetails(req.params.userId);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// AUDIT LOGS
// --------------------------------------------------
const getAuditLogs = async (req, res, next) => {
  try {
    const data = await service.getAuditLogs(req.query.limit);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// ACTIVE SESSIONS
// --------------------------------------------------
const getSessions = async (req, res, next) => {
  try {
    const data = await service.getSessions(req.query.limit);
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// REVOKE SESSION
// --------------------------------------------------
const revokeSession = async (req, res, next) => {
  try {
    const data = await service.revokeSession({
      sessionId: req.params.sessionId,
      adminUserId: req.user.userId || req.user.id,
      ipAddress: req.ip
    });

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// CREATE USER
// --------------------------------------------------
const createUser = async (req, res, next) => {
  try {
    const { email, password, role, hubLocationId } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: 'Email, password, and role are required'
      });
    }

    if (
      !['TRADE_TESTER', 'CENTER_SUPERINTENDENT'].includes(role)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Only TRADE_TESTER and CENTER_SUPERINTENDENT can be created here'
      });
    }

    if (
      !Number.isInteger(Number(hubLocationId)) ||
      Number(hubLocationId) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'A valid hubLocationId is required'
      });
    }

    // This helper must be implemented in auth.service.js.
    // It must generate a new TOTP secret and encrypt it server-side.
    const enrollment = await authService.createEncryptedMfaSecret();

    if (!enrollment?.encryptedMfaSecret) {
      throw new Error('MFA secret generation failed');
    }

    const data = await service.createUser({
      email,
      password,
      role,
      hubLocationId: Number(hubLocationId),
      encryptedMfaSecret: enrollment.encryptedMfaSecret,
      adminUserId: req.user.userId || req.user.id,
      ipAddress: req.ip
    });

    // Return setup material only if the helper provides it.
    // Never return the encrypted secret or log either secret.
    return res.status(201).json({
      success: true,
      data,
      ...(enrollment.secret && enrollment.otpauthUrl
        ? {
            mfaEnrollment: {
              secret: enrollment.secret,
              otpauthUrl: enrollment.otpauthUrl
            }
          }
        : {})
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// LOCK USER
// --------------------------------------------------
const lockUser = async (req, res, next) => {
  try {
    const data = await service.lockUser({
      userId: req.params.userId,
      adminUserId: req.user.userId || req.user.id,
      ipAddress: req.ip
    });

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// UNLOCK USER
// --------------------------------------------------
const unlockUser = async (req, res, next) => {
  try {
    const data = await service.unlockUser({
      userId: req.params.userId,
      adminUserId: req.user.userId || req.user.id,
      ipAddress: req.ip
    });

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// RESET MFA
// --------------------------------------------------
const resetMfa = async (req, res, next) => {
  try {
    // Generate a fresh secret on the server, never in Postman.
    const enrollment = await authService.createEncryptedMfaSecret();

    if (!enrollment?.encryptedMfaSecret) {
      throw new Error('MFA secret generation failed');
    }

    const data = await service.resetMfa({
      userId: req.params.userId,
      encryptedMfaSecret: enrollment.encryptedMfaSecret,
      adminUserId: req.user.userId || req.user.id,
      ipAddress: req.ip
    });

    return res.json({
      success: true,
      data,
      ...(enrollment.secret && enrollment.otpauthUrl
        ? {
            mfaEnrollment: {
              secret: enrollment.secret,
              otpauthUrl: enrollment.otpauthUrl
            }
          }
        : {})
    });
  } catch (error) {
    next(error);
  }
};

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------
module.exports = {
  getDashboard,
  getUsers,
  getUserDetails,
  getAuditLogs,
  getSessions,
  revokeSession,
  createUser,
  lockUser,
  unlockUser,
  resetMfa
};