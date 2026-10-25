
const assert = require('node:assert/strict');
const test = require('node:test');

const assessmentModel = require('../src/modules/candidate/assessment.model');
const candidateModel = require('../src/modules/candidate/candidate.model');
const assessmentService = require('../src/modules/candidate/assessment.service');

const candidateId = '123e4567-e89b-12d3-a456-426614174000';
const testerUserId = '987e6543-e21b-12d3-a456-426614174000';

test('replaying the same clientRequestId returns the existing assessment without creating another', async (t) => {
    const originalFind = assessmentModel.findByClientRequestId;
    const originalCreate = assessmentModel.createAssessment;
    const originalCandidateFind = candidateModel.findById;

    t.after(() => {
        assessmentModel.findByClientRequestId = originalFind;
        assessmentModel.createAssessment = originalCreate;
        candidateModel.findById = originalCandidateFind;
    });

    const existingAssessment = {
        assessment_id: 'assessment-1',
        candidate_id: candidateId,
        client_request_id: 'offline-request-1',
        status: 'DRAFT'
    };

    let createCalls = 0;

    assessmentModel.findByClientRequestId = async () => existingAssessment;
    assessmentModel.createAssessment = async () => {
        createCalls += 1;
        return existingAssessment;
    };
    candidateModel.findById = async () => ({
        candidate_id: candidateId,
        testing_hub_id: 7
    });

    const result = await assessmentService.createAssessment({
        candidateId,
        score: 85,
        grade: 'A',
        clientRequestId: 'offline-request-1',
        user: {
            userId: testerUserId,
            hubLocationId: 7,
            role: 'TRADE_TESTER'
        }
    });

    assert.equal(result.replayed, true);
    assert.equal(result.assessment, existingAssessment);
    assert.equal(createCalls, 0);
});
