const express = require('express');
const controller = require('./superAdmin.controller');
const { authenticate, requireRole } = require('../auth/auth.middleware');

const router = express.Router();

router.use(authenticate, requireRole('SUPER_ADMIN'));

router.get('/dashboard', controller.getDashboard);
router.get('/users', controller.getUsers);
router.get('/users/:userId', controller.getUserDetails);
router.get('/audit-logs', controller.getAuditLogs);
router.get('/sessions', controller.getSessions);
router.post('/sessions/:sessionId/revoke', controller.revokeSession);

// New account-management endpoints
router.post('/users', controller.createUser);
router.post('/users/:userId/lock', controller.lockUser);
router.post('/users/:userId/unlock', controller.unlockUser);
router.post('/users/:userId/reset-mfa', controller.resetMfa);

module.exports = router;