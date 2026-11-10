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

// CNIC lookup. The CNIC is stored only as a hash, so it is matched
// server-side. POST keeps the CNIC out of URLs and access logs.
router.post(
    '/lookup',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    candidateController.lookupCandidate
);

router.get(
    '/',
    authenticate,
    candidateController.listCandidates
);

module.exports = router;