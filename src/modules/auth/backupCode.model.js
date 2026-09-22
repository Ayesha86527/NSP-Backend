const bcrypt = require('bcrypt');

const pool = require('../../config/db');


/*
 * Check whether backup codes already exist for a user.
 */
const countBackupCodes = async (userId) => {
    const result = await pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM auth.backup_codes
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0].count;
};


/*
 * Store one backup-code hash.
 */
const createBackupCode = async (
    userId,
    codeHash
) => {
    const result = await pool.query(
        `
        INSERT INTO auth.backup_codes (
            user_id,
            code_hash
        )
        VALUES ($1, $2)
        RETURNING
            backup_code_id,
            user_id,
            created_at
        `,
        [
            userId,
            codeHash
        ]
    );

    return result.rows[0];
};


/*
 * Find and consume a backup code.
 *
 * The transaction locks unused codes for this user
 * while checking and consuming the matching code.
 */
const verifyAndConsumeBackupCode = async (
    userId,
    backupCode
) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `
            SELECT
                backup_code_id,
                code_hash
            FROM auth.backup_codes
            WHERE user_id = $1
              AND used_at IS NULL
            FOR UPDATE
            `,
            [userId]
        );

        for (const row of result.rows) {
            const matches = await bcrypt.compare(
                backupCode,
                row.code_hash
            );

            if (matches) {
                await client.query(
                    `
                    UPDATE auth.backup_codes
                    SET used_at = now()
                    WHERE backup_code_id = $1
                      AND used_at IS NULL
                    `,
                    [row.backup_code_id]
                );

                await client.query('COMMIT');

                return {
                    success: true,
                    backupCodeId: row.backup_code_id
                };
            }
        }

        await client.query('ROLLBACK');

        return {
            success: false
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};


/*
 * Get backup-code usage status.
 */
const getBackupCodeStatus = async (userId) => {
    const result = await pool.query(
        `
        SELECT
            COUNT(*)::int AS total_codes,
            COUNT(*) FILTER (
                WHERE used_at IS NULL
            )::int AS unused_codes,
            COUNT(*) FILTER (
                WHERE used_at IS NOT NULL
            )::int AS used_codes
        FROM auth.backup_codes
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0];
};


module.exports = {
    countBackupCodes,
    createBackupCode,
    verifyAndConsumeBackupCode,
    getBackupCodeStatus
};