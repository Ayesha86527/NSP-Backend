const pool = require('../../config/db');

const findUserByEmail = async (email) => {
    const result = await pool.query(
        `
        SELECT
            user_id,
            email,
            password_hash,
            role,
            hub_location_id,
            mfa_secret,
            is_mfa_active,
            created_at
        FROM auth.users
        WHERE email = $1
        `,
        [email]
    );

    return result.rows[0] || null;
};

const findUserForMfa = async (email) => {
    const result = await pool.query(
        `
        SELECT
            user_id,
            email,
            role,
            mfa_secret,
            is_mfa_active
        FROM auth.users
        WHERE email = $1
        `,
        [email]
    );

    return result.rows[0] || null;
};

module.exports = {
    findUserByEmail,
    findUserForMfa
};