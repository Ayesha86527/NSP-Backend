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
    const result = await pool.query(
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

    return result.rows[0];
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
    findById,
    findByHub
};