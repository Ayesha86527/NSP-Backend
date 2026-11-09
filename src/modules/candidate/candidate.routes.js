const express = require('express');

const candidateController = require('./candidate.controller');

const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

const router = express.Router();

router.post(
    '/photo-upload-url',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    candidateController.createPhotoUploadUrl
);

router.post(
    '/',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    candidateController.enrolCandidate
);

router.get(
    '/',
    authenticate,
    candidateController.listCandidates
);

module.exports = router;