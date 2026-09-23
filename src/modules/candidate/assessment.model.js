const pool = require('../../config/db');

const createAssessment = async ({
    candidateId,
    score,
    grade,
    testerUserId
}) => {
    const result = await pool.query(
        `
        INSERT INTO candidate.assessment_records (
            candidate_id,
            score,
            grade,
            tester_user_id,
            status
        )
        VALUES ($1, $2, $3, $4, 'DRAFT')
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
            candidateId,
            score,
            grade,
            testerUserId
        ]
    );

    return result.rows[0];
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

module.exports = {
    createAssessment,
    findById,
    findByCandidateAndTester,
    findByTester,
    updateDraft,
    submitDraft
};