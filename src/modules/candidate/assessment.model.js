const pool = require('../../config/db');

const createAssessment = async ({
    candidateId,
    score,
    grade,
    testerUserId,
    clientRequestId
}) => {
    const result = await pool.query(
        `
        INSERT INTO candidate.assessment_records (
            candidate_id,
            score,
            grade,
            tester_user_id,
            client_request_id,
            status
        )
        VALUES ($1, $2, $3, $4, $5, 'DRAFT')
        RETURNING
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at,
            client_request_id
        `,
        [
            candidateId,
            score,
            grade,
            testerUserId,
            clientRequestId
        ]
    );

    return result.rows[0];
};
const findByClientRequestId = async ({
    testerUserId,
    clientRequestId
}) => {
    const result = await pool.query(
        `
        SELECT
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at,
            client_request_id
        FROM candidate.assessment_records
        WHERE tester_user_id = $1
          AND client_request_id = $2
        LIMIT 1
        `,
        [
            testerUserId,
            clientRequestId
        ]
    );

    return result.rows[0] || null;
};

const findById = async (assessmentId) => {
    const result = await pool.query(
        `
        SELECT
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at
        FROM candidate.assessment_records
        WHERE assessment_id = $1
        `,
        [assessmentId]
    );

    return result.rows[0] || null;
};

const findByCandidateAndTester = async ({
    candidateId,
    testerUserId
}) => {
    const result = await pool.query(
        `
        SELECT
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at
        FROM candidate.assessment_records
        WHERE candidate_id = $1
          AND tester_user_id = $2
        ORDER BY submitted_at DESC NULLS LAST, assessment_id DESC
        `,
        [
            candidateId,
            testerUserId
        ]
    );

    return result.rows;
};

const findByTester = async (testerUserId) => {
    const result = await pool.query(
        `
        SELECT
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at
        FROM candidate.assessment_records
        WHERE tester_user_id = $1
        ORDER BY submitted_at DESC NULLS LAST, assessment_id DESC
        `,
        [testerUserId]
    );

    return result.rows;
};

const updateDraft = async ({
    assessmentId,
    score,
    grade,
    testerUserId
}) => {
    const result = await pool.query(
        `
        UPDATE candidate.assessment_records
        SET
            score = $1,
            grade = $2
        WHERE assessment_id = $3
          AND tester_user_id = $4
          AND status = 'DRAFT'
        RETURNING
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at
        `,
        [
            score,
            grade,
            assessmentId,
            testerUserId
        ]
    );

    return result.rows[0] || null;
};

const submitDraft = async ({
    assessmentId,
    testerUserId
}) => {
    const result = await pool.query(
        `
        UPDATE candidate.assessment_records
        SET
            status = 'SUBMITTED',
            submitted_at = NOW()
        WHERE assessment_id = $1
          AND tester_user_id = $2
          AND status = 'DRAFT'
        RETURNING
            assessment_id,
            candidate_id,
            score,
            grade,
            tester_user_id,
            superintendent_user_id,
            status,
            rejection_reason,
            submitted_at,
            approved_at
        `,
        [
            assessmentId,
            testerUserId
        ]
    );

    return result.rows[0] || null;
};

const findSubmittedForSuperintendent = async (hubId) => {
    const result = await pool.query(
        `
        SELECT
            ar.assessment_id,
            ar.candidate_id,
            c.full_name,
            c.trade_category,
            c.testing_hub_id,
            ar.score,
            ar.grade,
            ar.tester_user_id,
            ar.superintendent_user_id,
            ar.status,
            ar.rejection_reason,
            ar.submitted_at,
            ar.approved_at
        FROM candidate.assessment_records ar
        INNER JOIN candidate.candidates c
            ON c.candidate_id = ar.candidate_id
        WHERE ar.status = 'SUBMITTED'
          AND c.testing_hub_id = $1
        ORDER BY ar.submitted_at ASC
        `,
        [hubId]
    );

    return result.rows;
};


const approveAssessment = async ({
    assessmentId,
    superintendentUserId
}) => {
    const result = await pool.query(
        `
        UPDATE candidate.assessment_records ar
        SET
            status = 'APPROVED',
            superintendent_user_id = $2,
            approved_at = NOW()
        FROM candidate.candidates c
        WHERE ar.assessment_id = $1
          AND ar.candidate_id = c.candidate_id
          AND ar.status = 'SUBMITTED'
        RETURNING
            ar.assessment_id,
            ar.candidate_id,
            ar.score,
            ar.grade,
            ar.tester_user_id,
            ar.superintendent_user_id,
            ar.status,
            ar.rejection_reason,
            ar.submitted_at,
            ar.approved_at,
            c.trade_category,
            c.testing_hub_id
        `,
        [
            assessmentId,
            superintendentUserId
        ]
    );

    return result.rows[0] || null;
};


const rejectAssessment = async ({
    assessmentId,
    superintendentUserId,
    rejectionReason
}) => {
    const result = await pool.query(
        `
        UPDATE candidate.assessment_records ar
        SET
            status = 'DRAFT',
            superintendent_user_id = $2,
            rejection_reason = $3
        FROM candidate.candidates c
        WHERE ar.assessment_id = $1
          AND ar.candidate_id = c.candidate_id
          AND ar.status = 'SUBMITTED'
        RETURNING
            ar.assessment_id,
            ar.candidate_id,
            ar.score,
            ar.grade,
            ar.tester_user_id,
            ar.superintendent_user_id,
            ar.status,
            ar.rejection_reason,
            ar.submitted_at,
            ar.approved_at,
            c.trade_category,
            c.testing_hub_id
        `,
        [
            assessmentId,
            superintendentUserId,
            rejectionReason
        ]
    );

    return result.rows[0] || null;
};

module.exports = {
    createAssessment,
    findById,
    findByCandidateAndTester,
    findByTester,
    updateDraft,
    submitDraft,
    findByClientRequestId,
    findSubmittedForSuperintendent,
    approveAssessment,
    rejectAssessment
};