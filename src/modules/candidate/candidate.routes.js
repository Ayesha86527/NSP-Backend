const express = require('express');

const candidateController = require('./candidate.controller');
const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

const router = express.Router();

router.post(
    '/',
    authenticate,
    requireRole('TRADE_TESTER'),
    candidateController.enrolCandidate
);

module.exports = router;