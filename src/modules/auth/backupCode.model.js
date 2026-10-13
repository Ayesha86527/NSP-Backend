
const bcrypt = require('bcrypt');
const pool = require('../../config/db');

/**
 * Count all backup codes for a user.
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

/**
 * Store one backup-code hash.
 */
const createBackupCode = async (userId, codeHash) => {
    const result = await pool.query(
        `
        INSERT INTO auth.backup_codes (
            user_id,
            code_hash
        )
        VALUES ($1, $2)
        RETURNING backup_code_id, user_id, created_at
        `,
        [userId, codeHash]
    );

    return result.rows[0];
};

/**
 * Store multiple hashes in one transaction.
 */
const createBackupCodes = async (userId, codeHashes) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const insertedCodes = [];

        for (const codeHash of codeHashes) {
            const result = await client.query(
                `
                INSERT INTO auth.backup_codes (
                    user_id,
                    code_hash
                )
                VALUES ($1, $2)
                RETURNING backup_code_id, user_id, created_at
                `,
                [userId, codeHash]
            );

            insertedCodes.push(result.rows[0]);
        }

        await client.query('COMMIT');
        return insertedCodes;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

/**
 * Atomically ensure that only one backup-code set is generated
 * for a user. Locks the user row while checking and inserting.
 */
const generateBackupCodesIfAbsent = async (userId, codeHashes) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Serialize generation requests for this user.
        const userResult = await client.query(
            `
            SELECT user_id
            FROM auth.users
            WHERE user_id = $1
            FOR UPDATE
            `,
            [userId]
        );

        if (userResult.rowCount === 0) {
            await client.query('ROLLBACK');

            return {
                created: false,
                reason: 'user_not_found'
            };
        }

        const existingResult = await client.query(
            `
            SELECT COUNT(*)::int AS count
            FROM auth.backup_codes
            WHERE user_id = $1
            `,
            [userId]
        );

        if (existingResult.rows[0].count > 0) {
            await client.query('ROLLBACK');

            return {
                created: false,
                reason: 'already_exists'
            };
        }

        for (const codeHash of codeHashes) {
            await client.query(
                `
                INSERT INTO auth.backup_codes (
                    user_id,
                    code_hash
                )
                VALUES ($1, $2)
                `,
                [userId, codeHash]
            );
        }

        await client.query('COMMIT');

        return {
            created: true
        };
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Backup-code transaction rollback failed');
        }

        throw error;
    } finally {
        client.release();
    }
};

/**
 * Find and consume a backup code exactly once.
 */
const verifyAndConsumeBackupCode = async (userId, backupCode) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `
            SELECT backup_code_id, code_hash
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
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Backup-code verification rollback failed');
        }

        throw error;
    } finally {
        client.release();
    }
};

/**
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
    createBackupCodes,
    generateBackupCodesIfAbsent,
    verifyAndConsumeBackupCode,
    getBackupCodeStatus
};
