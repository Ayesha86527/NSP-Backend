const pool = require('../../config/db');

const createMedia = async ({
    assessmentId,
    mediaType,
    mediaS3Uri
}) => {
    const result = await pool.query(
        `
        INSERT INTO candidate.assessment_media (
            assessment_id,
            media_type,
            media_s3_uri
        )
        VALUES ($1, $2, $3)
        RETURNING
            media_id,
            assessment_id,
            media_type,
            media_s3_uri,
            created_at
        `,
        [
            assessmentId,
            mediaType,
            mediaS3Uri
        ]
    );

    return result.rows[0];
};

const findByAssessment = async (assessmentId) => {
    const result = await pool.query(
        `
        SELECT
            media_id,
            assessment_id,
            media_type,
            media_s3_uri,
            created_at
        FROM candidate.assessment_media
        WHERE assessment_id = $1
        ORDER BY created_at ASC
        `,
        [assessmentId]
    );

    return result.rows;
};

const findOneByAssessment = async (assessmentId) => {
    const result = await pool.query(
        `
        SELECT
            media_id,
            assessment_id,
            media_type,
            media_s3_uri,
            created_at
        FROM candidate.assessment_media
        WHERE assessment_id = $1
        ORDER BY created_at ASC
        LIMIT 1
        `,
        [assessmentId]
    );

    return result.rows[0] || null;
};

module.exports = {
    createMedia,
    findByAssessment,
    findOneByAssessment
};