
const test = require('node:test');
const assert = require('node:assert/strict');

const assessmentModel = require('../src/modules/candidate/assessment.model');
const candidateModel = require('../src/modules/candidate/candidate.model');
const auditModel = require('../src/modules/auth/audit.model');

// Mock database-facing methods so this test does not modify live data.
const originalAssessmentMethods = {
    findById: assessmentModel.findById,
    rejectAssessment: assessmentModel.rejectAssessment
};
const originalCandidateFindById = candidateModel.findById;
const originalCreateAuditLog = auditModel.createAuditLog;

const service = require('../src/modules/candidate/assessment.service');

const superintendent = {
    userId: 'superintendent-test-id',
    role: 'CENTER_SUPERINTENDENT',
    hubLocationId: 'hub-test-id'
};

const submittedAssessment = {
    assessment_id: 'assessment-test-id',
    candidate_id: 'candidate-test-id',
    tester_user_id: 'tester-test-id',
    status: 'SUBMITTED'
};

const candidate = {
    candidate_id: 'candidate-test-id',
    testing_hub_id: 'hub-test-id'
};

test.beforeEach(() => {
    assessmentModel.findById = async () => ({
        ...submittedAssessment
    });

    candidateModel.findById = async () => ({
        ...candidate
    });

    assessmentModel.rejectAssessment = async ({
        assessmentId,
        superintendentUserId,
        rejectionReason
    }) => ({
        assessment_id: assessmentId,
        candidate_id: 'candidate-test-id',
        superintendent_user_id: superintendentUserId,
        status: 'DRAFT',
        rejection_reason: rejectionReason,
        testing_hub_id: 'hub-test-id'
    });

    auditModel.createAuditLog = async () => ({});
});

test('rejecting a SUBMITTED assessment returns it to DRAFT', async () => {
    const result = await service.rejectAssessment({
        assessmentId: 'assessment-test-id',
        rejectionReason: '  Evidence photo is unclear  ',
        user: superintendent
    });

    assert.equal(result.status, 'DRAFT');
    assert.equal(
        result.rejection_reason,
        'Evidence photo is unclear'
    );
    assert.equal(
        result.superintendent_user_id,
        superintendent.userId
    );
});

test('rejection requires a non-empty reason', async () => {
    await assert.rejects(
        service.rejectAssessment({
            assessmentId: 'assessment-test-id',
            rejectionReason: '   ',
            user: superintendent
        }),
        { statusCode: 400, message: 'Rejection reason is required' }
    );
});

test('a DRAFT assessment cannot be rejected', async () => {
    assessmentModel.findById = async () => ({
        ...submittedAssessment,
        status: 'DRAFT'
    });

    let rejectCalled = false;
    assessmentModel.rejectAssessment = async () => {
        rejectCalled = true;
    };

    await assert.rejects(
        service.rejectAssessment({
            assessmentId: 'assessment-test-id',
            rejectionReason: 'Please correct the evidence',
            user: superintendent
        }),
        { statusCode: 409 }
    );

    assert.equal(rejectCalled, false);
});

test('a Superintendent cannot reject an assessment from another hub', async () => {
    candidateModel.findById = async () => ({
        ...candidate,
        testing_hub_id: 'different-hub-id'
    });

    let rejectCalled = false;
    assessmentModel.rejectAssessment = async () => {
        rejectCalled = true;
    };

    await assert.rejects(
        service.rejectAssessment({
            assessmentId: 'assessment-test-id',
            rejectionReason: 'Please correct the evidence',
            user: superintendent
        }),
        { statusCode: 403 }
    );

    assert.equal(rejectCalled, false);
});

test.after(() => {
    assessmentModel.findById = originalAssessmentMethods.findById;
    assessmentModel.rejectAssessment =
        originalAssessmentMethods.rejectAssessment;
    candidateModel.findById = originalCandidateFindById;
    auditModel.createAuditLog = originalCreateAuditLog;
});
