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
            created_at,
            failed_login_attempts,
            locked_until
        FROM auth.users
        WHERE email = $1
        `,
        [email]
    );

    return result.rows[0] || null;
};

const recordFailedLogin = async (userId) => {
    const result = await pool.query(
        `
        UPDATE auth.users
        SET
            failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
                WHEN failed_login_attempts + 1 >= 5
                THEN now() + INTERVAL '15 minutes'
                ELSE locked_until
            END
        WHERE user_id = $1
        RETURNING
            failed_login_attempts,
            locked_until
        `,
        [userId]
    );

    return result.rows[0] || null;
};

const resetFailedLoginAttempts = async (userId) => {
    await pool.query(
        `
        UPDATE auth.users
        SET
            failed_login_attempts = 0,
            locked_until = NULL
        WHERE user_id = $1
        `,
        [userId]
    );
};

const recordFailedMfa = async (userId) => {
    const result = await pool.query(
        `
        UPDATE auth.users
        SET
            failed_mfa_attempts = failed_mfa_attempts + 1,
            mfa_locked_until = CASE
                WHEN failed_mfa_attempts + 1 >= 5
                THEN NOW() + INTERVAL '15 minutes'
                ELSE mfa_locked_until
            END
        WHERE user_id = $1
        RETURNING
            failed_mfa_attempts,
            mfa_locked_until
        `,
        [userId]
    );

    return result.rows[0] || null;
};

const resetFailedMfa = async (userId) => {
    await pool.query(
        `
        UPDATE auth.users
        SET
            failed_mfa_attempts = 0,
            mfa_locked_until = NULL
        WHERE user_id = $1
        `,
        [userId]
    );
};

const findUserForMfa = async (email) => {
    const result = await pool.query(
        `
        SELECT
            user_id,
            email,
            role,
            hub_location_id,
            mfa_secret,
            is_mfa_active,
            locked_until
        FROM auth.users
        WHERE email = $1
        `,
        [email]
    );

    return result.rows[0] || null;
};

const findSessionByRefreshTokenHash = async (refreshTokenHash) => {
    const result = await pool.query(
        `
        SELECT
            session_id,
            user_id,
            refresh_token_hash,
            ip_address,
            device_fingerprint,
            expires_at,
            revoked
        FROM auth.sessions
        WHERE refresh_token_hash = $1
        `,
        [refreshTokenHash]
    );

    return result.rows[0] || null;
};

// Find a previously rotated refresh token.
const findRefreshTokenHistory = async (tokenHash) => {
    const result = await pool.query(
        `
        SELECT
            h.session_id,
            s.user_id
        FROM auth.refresh_token_history h
        JOIN auth.sessions s
          ON s.session_id = h.session_id
        WHERE h.token_hash = $1
        `,
        [tokenHash]
    );

    return result.rows[0] || null;
};

const findUserById = async (userId) => {
    const result = await pool.query(
        `
        SELECT
            user_id,
            email,
            role,
            hub_location_id
        FROM auth.users
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0] || null;
};

const revokeSession = async (sessionId) => {
    await pool.query(
        `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE session_id = $1
        `,
        [sessionId]
    );
};

// Revoke the session associated with a reused refresh token.
const revokeSessionFamily = async (sessionId) => {
    await pool.query(
        `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE session_id = $1
        `,
        [sessionId]
    );
};

// Rotate the refresh token and save the previous hash atomically.
const rotateRefreshToken = async (
    sessionId,
    oldRefreshTokenHash,
    newRefreshTokenHash,
    expiresAt,
    ipAddress,
    deviceFingerprint = null
) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `
            UPDATE auth.sessions
            SET
                refresh_token_hash = $1,
                expires_at = $2,
                ip_address = $3,
                device_fingerprint = COALESCE(device_fingerprint, $6)
            WHERE session_id = $4
              AND refresh_token_hash = $5
              AND revoked = FALSE
              AND expires_at > NOW()
            RETURNING
                session_id,
                user_id,
                refresh_token_hash,
                ip_address,
                device_fingerprint,
                expires_at,
                revoked
            `,
            [
                newRefreshTokenHash,
                expiresAt,
                ipAddress,
                sessionId,
                oldRefreshTokenHash,
                deviceFingerprint
            ]
        );

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }

        await client.query(
            `
            INSERT INTO auth.refresh_token_history (
                token_hash,
                session_id
            )
            VALUES ($1, $2)
            ON CONFLICT (token_hash) DO NOTHING
            `,
            [oldRefreshTokenHash, sessionId]
        );

        await client.query('COMMIT');

        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const findUserPasswordById = async (userId) => {
    const result = await pool.query(
        `
        SELECT user_id, email, password_hash
        FROM auth.users
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0] || null;
};

const findUserProfileById = async (userId) => {
    const result = await pool.query(
        `
        SELECT
            user_id,
            email,
            role,
            hub_location_id,
            created_at,
            is_mfa_active
        FROM auth.users
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0] || null;
};

const updatePasswordAndRevokeSessions = async (userId, passwordHash) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userResult = await client.query(
            `
            UPDATE auth.users
            SET
                password_hash = $1,
                token_version = token_version + 1
            WHERE user_id = $2
            RETURNING user_id, email
            `,
            [passwordHash, userId]
        );

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return null;
        }

        await client.query(
            `
            UPDATE auth.sessions
            SET revoked = TRUE
            WHERE user_id = $1
              AND revoked = FALSE
            `,
            [userId]
        );

        await client.query('COMMIT');

        return userResult.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const listUserSessions = async (userId) => {
    const result = await pool.query(
        `
        SELECT
            session_id,
            ip_address,
            device_fingerprint,
            expires_at,
            revoked,
            (
                revoked = FALSE AND expires_at > NOW()
            ) AS is_active
        FROM auth.sessions
        WHERE user_id = $1
        ORDER BY expires_at DESC
        `,
        [userId]
    );

    return result.rows;
};

module.exports = {
    findUserByEmail,
    findUserForMfa,
    findSessionByRefreshTokenHash,
    findRefreshTokenHistory,
    findUserById,
    revokeSession,
    revokeSessionFamily,
    rotateRefreshToken,
    recordFailedLogin,
    resetFailedLoginAttempts,
    recordFailedMfa,
    resetFailedMfa,
    findUserPasswordById,
    findUserProfileById,
    updatePasswordAndRevokeSessions,
    listUserSessions
};