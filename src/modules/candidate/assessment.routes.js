const express = require('express');

const assessmentController =
    require('./assessment.controller');

const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

const router = express.Router();


/*
 * Superintendent approval workflow.
 *
 * These routes must appear before the dynamic
 * /:assessmentId route.
 */
router.get(
    '/queue',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    assessmentController.getApprovalQueue
);

router.post(
    '/:assessmentId/approve',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    assessmentController.approveAssessment
);

router.post(
    '/:assessmentId/reject',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN'),
    assessmentController.rejectAssessment
);


/*
 * Trade Tester assessment workflow.
 */
router.post(
    '/',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.createAssessment
);

router.get(
    '/',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.getMyAssessments
);

router.get(
    '/:assessmentId',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.getAssessment
);

router.patch(
    '/:assessmentId',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.updateAssessment
);

router.post(
    '/:assessmentId/submit',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.submitAssessment
);

router.post(
    '/:assessmentId/photo-upload-url',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.createAssessmentPhotoUploadUrl
);

router.post(
    '/:assessmentId/media',
    authenticate,
    requireRole('TRADE_TESTER'),
    assessmentController.addAssessmentMedia
);

router.get(
    '/:assessmentId/media',
    authenticate,
    requireRole(
        'TRADE_TESTER',
        'CENTER_SUPERINTENDENT',
        'SUPERINTENDENT',
        'SUPER_ADMIN'
    ),
    assessmentController.getAssessmentMedia
);


module.exports = router;