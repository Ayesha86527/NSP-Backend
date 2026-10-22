const express = require('express');
const router = express.Router();
const {
    verifyCredentialController
} = require('../ledger/ledger.controller');

/**
 * Public On-Chain Verification Route (FR-VERI-01)
 * Zero-authentication endpoint to verify credentials against Polygon Amoy testnet.
 * Accessible at: GET /api/verify/:credentialId
 */
router.get(
    '/:credentialId',
    verifyCredentialController
);

module.exports = router;
