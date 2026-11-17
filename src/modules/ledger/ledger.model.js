const pool = require('../../config/db');

const createLedgerError = (message, statusCode) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const createCredential = async ({
    credentialId,
    candidateId,
    createdBy,
    credentialSubject,
    rootHash
}) => {
    const result = await pool.query(
        `
        INSERT INTO ledger.credentials (
            credential_id,
            candidate_id,
            created_by,
            credential_subject,
            root_hash,
            issued_at,
            status
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), 'PENDING_APPROVAL')
        RETURNING *;
        `,
        [
            credentialId,
            candidateId,
            createdBy,
            JSON.stringify(credentialSubject),
            rootHash
        ]
    );
    return result.rows[0];
};

const approveAndQueueCredential = async ({
    credentialId,
    approverId,
    approverRole,
    hubLocationId
}) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const credentialResult = await client.query(
            `
            SELECT c.*
            FROM ledger.credentials c
            JOIN candidate.candidates candidate
                ON candidate.candidate_id = c.candidate_id
            WHERE c.credential_id = $1
              AND ($2 != 'CENTER_SUPERINTENDENT' OR candidate.testing_hub_id = $3)
            FOR UPDATE OF c;
            `,
            [credentialId, approverRole, hubLocationId]
        );
        const credential = credentialResult.rows[0];

        if (!credential) {
            throw createLedgerError('Credential not found.', 404);
        }

        if (credential.status === 'REVOKED') {
            throw createLedgerError('A revoked credential cannot be approved.', 409);
        }

        const payload = {
            credentialId: credential.credential_id,
            rootHash: credential.root_hash,
            w3cCredential: credential.credential_subject
        };

        const queueResult = await client.query(
            `
            SELECT *
            FROM ledger.minting_queue
            WHERE credential_id = $1
            FOR UPDATE;
            `,
            [credentialId]
        );
        const existingItem = queueResult.rows[0];
        let queueItem;

        if (existingItem && existingItem.status !== 'FAILED') {
            queueItem = existingItem;
        } else if (existingItem) {
            const retryResult = await client.query(
                `
                UPDATE ledger.minting_queue
                SET payload = $1,
                    status = 'QUEUED',
                    tx_hash = NULL,
                    attempt_count = 0,
                    last_error = NULL,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING *;
                `,
                [JSON.stringify(payload), existingItem.id]
            );
            queueItem = retryResult.rows[0];
        } else {
            const insertResult = await client.query(
                `
                INSERT INTO ledger.minting_queue (
                    credential_id,
                    payload,
                    status,
                    created_at,
                    updated_at
                )
                VALUES ($1, $2, 'QUEUED', NOW(), NOW())
                RETURNING *;
                `,
                [credentialId, JSON.stringify(payload)]
            );
            queueItem = insertResult.rows[0];
        }

        const shouldRecordApproval = !existingItem || existingItem.status === 'FAILED';
        await client.query(
            `
            UPDATE ledger.credentials
            SET status = CASE WHEN status = 'MINTED' THEN status ELSE 'APPROVED' END,
                approved_by = CASE WHEN $3 THEN $1 ELSE approved_by END,
                approved_at = CASE WHEN $3 THEN NOW() ELSE approved_at END
            WHERE credential_id = $2;
            `,
            [approverId, credentialId, shouldRecordApproval]
        );

        await client.query('COMMIT');
        return queueItem;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const getPendingQueueItems = async () => {
    const query = `
        SELECT *
        FROM ledger.minting_queue
        WHERE (status IN ('QUEUED', 'FAILED') AND attempt_count < 5)
           OR (
                status = 'BROADCASTED' 
                AND updated_at < NOW() - (INTERVAL '1 minute' * POWER(2, attempt_count))
              )
        ORDER BY created_at ASC
        LIMIT 10;
    `;
    const result = await pool.query(query);
    return result.rows;
};

const claimQueueItem = async (id) => {
    const result = await pool.query(
        `
        UPDATE ledger.minting_queue
        SET status = 'BROADCASTED',
            attempt_count = attempt_count + 1,
            updated_at = NOW()
        WHERE id = $1
          AND (
              (status IN ('QUEUED', 'FAILED') AND attempt_count < 5)
              OR (status = 'BROADCASTED' AND updated_at < NOW() - INTERVAL '30 minutes')
          )
        RETURNING *;
        `,
        [id]
    );
    return result.rows[0];
};

const updateQueueStatus = async (id, status, txHash = null, lastError = null) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await client.query(
            `
            UPDATE ledger.minting_queue
            SET status = $1,
                tx_hash = COALESCE($2, tx_hash),
                last_error = $3,
                updated_at = NOW()
            WHERE id = $4
            RETURNING credential_id;
            `,
            [status, txHash, lastError, id]
        );
        const queueItem = result.rows[0];

        if (!queueItem) {
            throw createLedgerError('Minting queue item not found.', 404);
        }

        if (status === 'MINTED') {
            await client.query(
                `
                UPDATE ledger.credentials
                SET status = 'MINTED'
                WHERE credential_id = $1
                  AND status != 'REVOKED';
                `,
                [queueItem.credential_id]
            );
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const getCredentialStatus = async (credentialId, user) => {
    const isAdmin = user.role === 'SUPER_ADMIN';
    const values = [credentialId];
    let accessFilter = '';

    if (user.role === 'TRADE_TESTER') {
        values.push(user.userId);
        accessFilter = 'AND c.created_by = $2';
    } else if (user.role === 'CENTER_SUPERINTENDENT') {
        values.push(user.hubLocationId);
        accessFilter = 'AND candidate.testing_hub_id = $2';
    } else if (!isAdmin) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            c.credential_id,
            c.status AS credential_status,
            c.issued_at,
            c.approved_at,
            q.status AS minting_status,
            q.tx_hash,
            q.attempt_count
        FROM ledger.credentials c
        JOIN candidate.candidates candidate
            ON candidate.candidate_id = c.candidate_id
        LEFT JOIN ledger.minting_queue q
            ON q.credential_id = c.credential_id
        WHERE c.credential_id = $1
        ${accessFilter};
        `,
        values
    );
    return result.rows[0] || null;
};

const revokeCredential = async (credentialId, reason, revokedBy) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkResult = await client.query(
            `
            SELECT * FROM ledger.credentials
            WHERE credential_id = $1
            FOR UPDATE;
            `,
            [credentialId]
        );
        const credential = checkResult.rows[0];

        if (!credential) {
            throw createLedgerError('Credential not found.', 404);
        }

        if (credential.status === 'REVOKED') {
            throw createLedgerError('Credential is already revoked.', 409);
        }

        const updateResult = await client.query(
            `
            UPDATE ledger.credentials
            SET status = 'REVOKED',
                updated_at = NOW()
            WHERE credential_id = $1
            RETURNING *;
            `,
            [credentialId]
        );

        console.log(`Credential ${credentialId} revoked by user ${revokedBy}. Reason: ${reason}`);

        await client.query('COMMIT');
        return updateResult.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const getCredentialByStringId = async (credentialId) => {
    const query = `
        SELECT 
            c.credential_id,
            c.candidate_id,
            c.credential_subject,
            c.root_hash,
            c.issued_at,
            c.approved_at,
            c.status,
            mq.tx_hash,
            cand.full_name      AS worker_name,
            cand.father_name    AS father_name,
            cand.dob            AS dob,
            cand.trade_category AS trade_category,
            cand.testing_hub_id AS testing_hub_id,
            cand.photo_s3_uri   AS photo_s3_uri,
            ar.score            AS assessment_score,
            ar.grade            AS assessment_grade
        FROM ledger.credentials c
        LEFT JOIN LATERAL (
            SELECT tx_hash
            FROM ledger.minting_queue
            WHERE credential_id = c.credential_id
              AND status = 'MINTED'
            ORDER BY created_at DESC
            LIMIT 1
        ) mq ON true
        LEFT JOIN candidate.candidates cand
            ON cand.candidate_id = c.candidate_id
        LEFT JOIN LATERAL (
            SELECT score, grade
            FROM candidate.assessment_records
            WHERE candidate_id = c.candidate_id
            ORDER BY approved_at DESC NULLS LAST
            LIMIT 1
        ) ar ON true
        WHERE c.credential_id = $1
        LIMIT 1;
    `;
    const { rows } = await pool.query(query, [credentialId]);
    return rows[0] || null;
};

const getQueueHealthStats = async () => {
    const query = `
        SELECT 
            status, 
            COUNT(*) AS count 
        FROM ledger.minting_queue 
        GROUP BY status;
    `;
    const result = await pool.query(query);
    return result.rows;
};

module.exports = {
    createCredential,
    approveAndQueueCredential,
    getPendingQueueItems,
    claimQueueItem,
    updateQueueStatus,
    getCredentialStatus,
    revokeCredential,
    getCredentialByStringId,
    getQueueHealthStats
};