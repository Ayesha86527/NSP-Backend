const express = require('express');
const authController = require('./auth.controller');

const {
  authenticate,
  authenticateMfaEnrollment,
  authenticateDevice,
  requireStepUp
} = require('./auth.middleware');

const router = express.Router();

router.post('/login', authController.login);

router.post('/verify-mfa', authController.verifyMfa);

router.post('/verify-backup-code', authController.verifyBackupCode);

router.post('/refresh', authController.refresh);

// MFA enrollment routes use a dedicated, short-lived enrollment token.
router.post(
  '/mfa/enroll/start',
  authenticateMfaEnrollment,
  authController.startMfaEnrollment
);

router.post(
  '/mfa/enroll/confirm',
  authenticateMfaEnrollment,
  authController.confirmMfaEnrollment
);

router.post(
  '/revoke',
  authenticate,
  authController.revokeSession
);

router.post(
  '/backup-codes/generate',
  authenticate,
  authController.generateBackupCodes
);

router.get(
  '/backup-codes/status',
  authenticate,
  authController.backupCodeStatus
);

// B1: Step-up MFA authentication.
// Requires a normal authenticated session.
// The endpoint issues a single-use, 5-minute step-up token.
router.post(
  '/step-up',
  authenticate,
  authController.stepUp
);

// B4: Return permissions for the authenticated user.
router.get(
  '/permissions',
  authenticate,
  authController.getPermissions
);

// B2: User profile and session management
router.get(
  '/profile',
  authenticate,
  authController.getProfile
);

router.patch(
  '/profile',
  authenticate,
  authController.updateProfile
);

router.get(
  '/sessions',
  authenticate,
  authController.getSessions
);

// Device health heartbeat.
// Uses device credential authentication, not the user JWT.
// Intentionally allowed during hub lockdown: it reports device
// health and does not authorize a user to log in.
router.post(
  '/device/heartbeat',
  authenticateDevice,
  authController.heartbeat
);

module.exports = router;