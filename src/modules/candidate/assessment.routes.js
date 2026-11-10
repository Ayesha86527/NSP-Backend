const express = require('express');

const assessmentController =
    require('./assessment.controller');

const {
    authenticate,
    requireRole
} = require('../auth/auth.middleware');

const router = express.Router();

/*
 * Roles that may create and manage assessments. Superintendents work
 * inside their own hub; Super Admins are not limited to a hub.
 */
const ASSESSORS = [
    'TRADE_TESTER',
    'CENTER_SUPERINTENDENT',
    'SUPERINTENDENT',
    'SUPER_ADMIN'
];


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
 * Assessment workflow (Trade Tester, Superintendent, Super Admin).
 */
router.post(
    '/',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.createAssessment
);

router.get(
    '/',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.getMyAssessments
);

router.get(
    '/:assessmentId',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.getAssessment
);

router.patch(
    '/:assessmentId',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.updateAssessment
);

router.post(
    '/:assessmentId/submit',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.submitAssessment
);

router.post(
    '/:assessmentId/photo-upload-url',
    authenticate,
    requireRole(...ASSESSORS),
    assessmentController.createAssessmentPhotoUploadUrl
);

router.post(
    '/:assessmentId/media',
    authenticate,
    requireRole(...ASSESSORS),
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