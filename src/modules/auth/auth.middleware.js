const jwt = require('jsonwebtoken');
const pool = require('../../config/db');
const { publicKey } = require('../../config/jwt');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256']
    });

    if (!decoded.sub || !Number.isInteger(decoded.tokenVersion)) {
      return res.status(401).json({
        success: false,
        message: 'Invalid access token'
      });
    }

    const result = await pool.query(
      `SELECT user_id, email, role, hub_location_id,
              admin_locked, token_version, is_mfa_active,
              mfa_enrollment_pending
         FROM auth.users
        WHERE user_id = $1`,
      [decoded.sub]
    );

    const user = result.rows[0];

    if (
      !user ||
      user.admin_locked ||
      Number(user.token_version) !== decoded.tokenVersion ||
      !user.is_mfa_active ||
      user.mfa_enrollment_pending
    ) {
      return res.status(401).json({
        success: false,
        message: 'Session is no longer valid. Please authenticate again.'
      });
    }

    req.user = {
      userId: user.user_id,
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id
    };

    return next();
  } catch (error) {
    if (
      error.name === 'JsonWebTokenError' ||
      error.name === 'TokenExpiredError'
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired access token'
      });
    }

    return next(error);
  }
};

const authenticateMfaEnrollment = async (req, res, next) => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'MFA enrollment authorization required'
      });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256']
    });

    if (
      decoded.purpose !== 'mfa_enrollment' ||
      !decoded.sub ||
      !Number.isInteger(decoded.tokenVersion)
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid enrollment token'
      });
    }

    const result = await pool.query(
      `SELECT user_id, email, role, hub_location_id,
              admin_locked, token_version, is_mfa_active,
              mfa_enrollment_pending
         FROM auth.users
        WHERE user_id = $1`,
      [decoded.sub]
    );

    const user = result.rows[0];

    if (
      !user ||
      user.admin_locked ||
      Number(user.token_version) !== decoded.tokenVersion ||
      user.is_mfa_active ||
      !user.mfa_enrollment_pending
    ) {
      return res.status(401).json({
        success: false,
        message: 'MFA enrollment authorization is no longer valid'
      });
    }

    req.user = {
      userId: user.user_id,
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id
    };

    return next();
  } catch (error) {
    if (
      error.name === 'JsonWebTokenError' ||
      error.name === 'TokenExpiredError'
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired enrollment token'
      });
    }

    return next(error);
  }
};

const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
  }

  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied'
    });
  }

  return next();
};

module.exports = {
  authenticate,
  authenticateMfaEnrollment,
  requireRole
};
