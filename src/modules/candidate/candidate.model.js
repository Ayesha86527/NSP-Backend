const pool = require('../../config/db');

const createCandidate = async ({
    fullName,
    fatherName,
    dob,
    cnicSaltedHash,
    cnicDedupHash,
    cnicBlindSalt,
    photoS3Uri,
    tradeCategory,
    testingHubId
}) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Serialize enrolment requests for this hub.
        // Different hubs use different advisory locks.
        await client.query(
            'SELECT pg_advisory_xact_lock($1, $2)',
            [20261025, testingHubId]
        );

        // Count candidates belonging to this hub only.
        const countResult = await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM candidate.candidates
            WHERE testing_hub_id = $1
            `,
            [testingHubId]
        );

        if (countResult.rows[0].count >= 60) {
            const error = new Error(
                'This testing hub has reached its maximum enrolment limit of 60 candidates'
            );
            error.statusCode = 409;
            throw error;
        }

        const result = await client.query(
            `
            INSERT INTO candidate.candidates (
                full_name,
                father_name,
                dob,
                cnic_salted_hash,
                cnic_dedup_hash,
                cnic_blind_salt,
                photo_s3_uri,
                trade_category,
                testing_hub_id
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING
                candidate_id,
                full_name,
                father_name,
                dob,
                photo_s3_uri,
                trade_category,
                testing_hub_id
            `,
            [
                fullName,
                fatherName,
                dob,
                cnicSaltedHash,
                cnicDedupHash,
                cnicBlindSalt,
                photoS3Uri,
                tradeCategory,
                testingHubId
            ]
        );

        await client.query('COMMIT');

        return result.rows[0];
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Candidate enrolment transaction rollback failed');
        }

        throw error;
    } finally {
        client.release();
    }
};

const findByDedupHash = async (cnicDedupHash) => {
    const result = await pool.query(
        `
        SELECT candidate_id
        FROM candidate.candidates
        WHERE cnic_dedup_hash = $1
        LIMIT 1
        `,
        [cnicDedupHash]
    );

    return result.rows[0] || null;
};

/**
 * Find candidates by one or more CNIC dedup hashes.
 * hubId = null searches every hub (Super Admin).
 */
const findByDedupHashes = async (cnicDedupHashes, hubId = null) => {
    const result = await pool.query(
        `
        SELECT
            candidate_id,
            full_name,
            father_name,
            dob,
            photo_s3_uri,
            trade_category,
            testing_hub_id
        FROM candidate.candidates
        WHERE cnic_dedup_hash = ANY($1::text[])
          AND ($2::int IS NULL OR testing_hub_id = $2)
        ORDER BY full_name
        `,
        [cnicDedupHashes, hubId]
    );

    return result.rows;
};

const findById = async (candidateId) => {
    const result = await pool.query(
        `
        SELECT
            candidate_id,
            full_name,
            father_name,
            dob,
            photo_s3_uri,
            trade_category,
            testing_hub_id
        FROM candidate.candidates
        WHERE candidate_id = $1
        `,
        [candidateId]
    );

    return result.rows[0] || null;
};

const findByIdInHub = async (candidateId, testingHubId) => {
    const result = await pool.query(
        `
        SELECT candidate_id
        FROM candidate.candidates
        WHERE candidate_id = $1
          AND testing_hub_id = $2
        `,
        [candidateId, testingHubId]
    );

    return result.rows[0] || null;
};

const findByHub = async (testingHubId) => {
    const result = await pool.query(
        `
        SELECT
            candidate_id,
            full_name,
            father_name,
            dob,
            photo_s3_uri,
            trade_category,
            testing_hub_id
        FROM candidate.candidates
        WHERE testing_hub_id = $1
        ORDER BY full_name
        `,
        [testingHubId]
    );

    return result.rows;
};

module.exports = {
    createCandidate,
    findByDedupHash,
    findByDedupHashes,
    findById,
    findByIdInHub,
    findByHub
};