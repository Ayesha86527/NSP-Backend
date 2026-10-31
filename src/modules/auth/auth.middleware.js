const crypto = require('crypto');
const { requireRole } = require('./role.middleware');
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

    if (
      !decoded.sub ||
      !Number.isInteger(decoded.tokenVersion) ||
      !decoded.sid
    ) {
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

    const sessionResult = await pool.query(
      `SELECT session_id
         FROM auth.sessions
        WHERE session_id = $1
          AND user_id = $2
          AND revoked = FALSE
          AND expires_at > NOW()`,
      [decoded.sid, user.user_id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Session has been revoked or expired. Please authenticate again.'
      });
    }

    req.user = {
      userId: user.user_id,
      id: user.user_id,
      email: user.email,
      role: user.role,
      hubLocationId: user.hub_location_id,
      sessionId: decoded.sid
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

// ======================================================
// STEP-UP MFA AUTHORIZATION (B1)
// ======================================================
const requireStepUp = (requiredScope) => {
  const allowedScopes = [
    'APPROVE_ASSESSMENT',
    'REVOKE_CREDENTIAL',
    'REGISTER_HUB_KEY',
    'CHANGE_ROLE',
    'RESET_MFA'
  ];

  // Validate the scope when the route is configured.
  if (!allowedScopes.includes(requiredScope)) {
    throw new Error(`Invalid step-up scope: ${requiredScope}`);
  }

  return async (req, res, next) => {
    try {
      const stepUpToken = req.headers['x-step-up-token'];

      if (!stepUpToken) {
        return res.status(401).json({
          success: false,
          message: 'Step-up authentication token is required'
        });
      }

      if (!req.user?.userId || !req.user?.sessionId) {
        return res.status(401).json({
          success: false,
          message: 'Authenticated user session is required'
        });
      }

      let decoded;

      try {
        decoded = jwt.verify(stepUpToken, publicKey, {
          algorithms: ['RS256']
        });
      } catch (error) {
        if (
          error.name === 'JsonWebTokenError' ||
          error.name === 'TokenExpiredError' ||
          error.name === 'NotBeforeError'
        ) {
          return res.status(401).json({
            success: false,
            message: 'Invalid or expired step-up token'
          });
        }

        throw error;
      }

      // Verify token purpose and ownership.
      if (
        decoded.purpose !== 'step_up' ||
        decoded.sub !== req.user.userId ||
        decoded.sid !== req.user.sessionId ||
        !decoded.jti
      ) {
        return res.status(401).json({
          success: false,
          message: 'Step-up token is not valid for this session'
        });
      }

      // A token must only authorize its intended operation.
      if (decoded.scope !== requiredScope) {
        return res.status(403).json({
          success: false,
          message: 'Step-up token does not authorize this operation'
        });
      }

      // Hash the token; the raw token is never stored in the database.
      const tokenHash = crypto
        .createHash('sha256')
        .update(stepUpToken)
        .digest('hex');

      // Atomically consume the token.
      // Only one request can successfully update an unused token.
      const result = await pool.query(
        `
        UPDATE auth.step_up_tokens
        SET used_at = NOW()
        WHERE token_hash = $1
          AND user_id = $2
          AND session_id = $3
          AND scope = $4
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING token_hash
        `,
        [
          tokenHash,
          req.user.userId,
          req.user.sessionId,
          requiredScope
        ]
      );

      if (result.rowCount !== 1) {
        return res.status(401).json({
          success: false,
          message: 'Step-up token is expired, invalid, or already used'
        });
      }

      req.stepUp = {
        scope: requiredScope,
        tokenId: decoded.jti
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
};

module.exports = {
  authenticate,
  authenticateMfaEnrollment,
  requireRole,
  requireStepUp
};