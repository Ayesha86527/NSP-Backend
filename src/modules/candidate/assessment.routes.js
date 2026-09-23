const express = require('express');

const assessmentController =
    require('./assessment.controller');

const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

const router = express.Router();

router.use(
    authenticate,
    requireRole('TRADE_TESTER')
);

router.post(
    '/',
    assessmentController.createAssessment
);

router.get(
    '/',
    assessmentController.getMyAssessments
);

router.get(
    '/:assessmentId',
    assessmentController.getAssessment
);

router.patch(
    '/:assessmentId',
    assessmentController.updateAssessment
);

router.post(
    '/:assessmentId/submit',
    assessmentController.submitAssessment
);

module.exports = router;