const express = require('express');
const { verifyCredentialController } = require('./verification.controller');

const router = express.Router();
router.get('/:credentialId', verifyCredentialController);

module.exports = router;
