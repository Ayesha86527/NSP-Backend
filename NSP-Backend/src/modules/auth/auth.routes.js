const express = require('express');
const authController = require('./auth.controller');

const router = express.Router();

router.post('/login', authController.login);

router.post('/verify-mfa', authController.verifyMfa);

module.exports = router;