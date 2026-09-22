const express = require('express');
const authController = require('./auth.controller');
const {
    authenticate
} = require('./auth.middleware');

const router = express.Router();


router.post(
    '/login',
    authController.login
);


router.post(
    '/verify-mfa',
    authController.verifyMfa
);


router.post(
    '/verify-backup-code',
    authController.verifyBackupCode
);


router.post(
    '/refresh',
    authController.refresh
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


module.exports = router;