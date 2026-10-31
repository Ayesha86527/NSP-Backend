const express = require('express');
const authController = require('./auth.controller');

const {
  authenticate,
  authenticateMfaEnrollment,
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

module.exports = router;