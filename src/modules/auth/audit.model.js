const pool = require('../../config/db');

const createAuditLog = async ({
    userId,
    eventType,
    email = null,
    ipAddress = null,
    details = null,
    client = pool
}) => {
    const result = await client.query(
        `
        INSERT INTO auth.audit_logs (
            user_id,
            event_type,
            email,
            ip_address,
            details
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            audit_id,
            user_id,
            event_type,
            email,
            ip_address,
            details,
            created_at
        `,
        [userId, eventType, email, ipAddress, details]
    );

    return result.rows[0];
};

module.exports = {
    createAuditLog
};