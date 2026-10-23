const express = require('express');
const router = express.Router();
const {
    issueCredentialController,
    approveCredentialController,
    getCredentialStatusController,
    revokeCredentialController,
    getRelayerBalanceController
} = require('./ledger.controller');
const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

router.post(
    '/issue',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    issueCredentialController
);
router.post(
    '/approve',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    approveCredentialController
);
router.get(
    '/relayer-balance',
    authenticate,
    requireRole('SUPER_ADMIN'),
    getRelayerBalanceController
);
router.get(
    '/:credentialId',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    getCredentialStatusController
);
router.post(
    '/:credentialId/revoke',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    revokeCredentialController
);


module.exports = router;