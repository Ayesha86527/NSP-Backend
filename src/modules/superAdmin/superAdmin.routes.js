const express = require('express');
const controller = require('./superAdmin.controller');
const {
  authenticate,
  requireRole,
  requireStepUp
} = require('../auth/auth.middleware');

const router = express.Router();

router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/dashboard', controller.getDashboard);
router.get('/users', controller.getUsers);
router.get('/users/:userId', controller.getUserDetails);
router.get('/audit-logs', controller.getAuditLogs);
router.get('/sessions', controller.getSessions);
router.post('/sessions/:sessionId/revoke', controller.revokeSession);

// Device management
router.post('/devices', controller.registerDevice);
router.get('/devices', controller.listDevices);
router.get('/devices/health', controller.getDeviceHealth);
router.post('/devices/lockdown', controller.setHubLockdown);
router.post('/devices/:deviceId/revoke', controller.revokeDevice);

// New account-management endpoints
router.post('/users', controller.createUser);
router.post('/users/:userId/lock', controller.lockUser);
router.post('/users/:userId/unlock', controller.unlockUser);
router.post('/users/:userId/reset-mfa', controller.resetMfa);

// B4: User and role administration — every mutation requires step-up MFA.
router.patch(
  '/users/:userId/role',
  requireStepUp('CHANGE_ROLE'),
  controller.changeUserRole
);

router.patch(
  '/users/:userId/hub',
  requireStepUp('REASSIGN_HUB'),
  controller.reassignUserHub
);

router.patch(
  '/users/:userId/status',
  requireStepUp('MANAGE_ACCOUNT_STATUS'),
  controller.setUserActiveStatus
);

router.post(
  '/users/:userId/reset-password',
  requireStepUp('ADMIN_PASSWORD_RESET'),
  controller.resetUserPassword
);

module.exports = router;