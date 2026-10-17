const express = require('express');
const router = express.Router();
const {
    issueCredentialController,
    approveCredentialController,
    getCredentialStatusController,
    verifyCredentialController
} = require('./ledger.controller');
const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

router.post(
    '/issue',
    authenticate,
    requireRole('TRADE_TESTER'),
    issueCredentialController
);

router.post(
    '/approve',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    approveCredentialController
);

router.get(
    '/verify/:credentialId',
    verifyCredentialController
);

router.get(
    '/:credentialId',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    getCredentialStatusController
);

module.exports = router;