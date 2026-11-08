const pool = require('../../config/db');
const bcrypt = require('bcrypt');
const { createAuditLog } = require('../auth/audit.model');

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------

const getDashboardStats = async () => {
  const [users, sessions, candidates, assessments, credentials, queue, hubs] =
    await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE role = 'SUPER_ADMIN')::int AS super_admins,
          COUNT(*) FILTER (WHERE role = 'CENTER_SUPERINTENDENT')::int AS center_superintendents,
          COUNT(*) FILTER (WHERE role = 'TRADE_TESTER')::int AS trade_testers,
          COUNT(*) FILTER (WHERE is_mfa_active = TRUE)::int AS active_mfa,
          COUNT(*) FILTER (WHERE mfa_enrollment_pending = TRUE)::int AS pending_mfa,
          COUNT(*) FILTER (WHERE admin_locked = TRUE)::int AS admin_locked,
          COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_users
        FROM auth.users
      `),
      pool.query(`
        SELECT COUNT(*)::int AS active_count
        FROM auth.sessions
        WHERE revoked = FALSE AND expires_at > NOW()
      `),
      pool.query(`
        SELECT COUNT(*)::int AS total_enrolled
        FROM candidate.candidates
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_assessed,
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
          COUNT(*) FILTER (WHERE status = 'SUBMITTED')::int AS submitted,
          COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'MINTED')::int AS minted,
          COUNT(*) FILTER (WHERE rejection_reason IS NOT NULL)::int AS rejected
        FROM candidate.assessment_records
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_credentials,
          COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL')::int AS pending_approval,
          COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
          COUNT(*) FILTER (WHERE status = 'MINTED')::int AS minted_on_chain,
          COUNT(*) FILTER (WHERE status = 'REVOKED')::int AS revoked
        FROM ledger.credentials
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('QUEUED', 'BROADCASTED'))::int AS queue_pending,
          COUNT(*) FILTER (WHERE status = 'FAILED')::int AS queue_failed,
          COUNT(*) FILTER (WHERE status IN ('CONFIRMED', 'MINTED'))::int AS queue_minted,
          COUNT(*)::int AS queue_total
        FROM ledger.minting_queue
      `),
      // One row per testing hub (hubs are numbered 1-5 by the DB CHECK
      // constraints), including hubs that have no data yet.
      pool.query(`
        SELECT
          h.hub_id,
          COALESCE(c.enrolled, 0)::int AS enrolled,
          COALESCE(a.draft, 0)::int AS draft,
          COALESCE(a.submitted, 0)::int AS submitted,
          COALESCE(a.approved, 0)::int AS approved,
          COALESCE(a.minted, 0)::int AS minted,
          COALESCE(a.total, 0)::int AS assessed
        FROM generate_series(1, 5) AS h(hub_id)
        LEFT JOIN (
          SELECT testing_hub_id, COUNT(*) AS enrolled
          FROM candidate.candidates
          GROUP BY testing_hub_id
        ) c ON c.testing_hub_id = h.hub_id
        LEFT JOIN (
          SELECT
            cand.testing_hub_id,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE ar.status = 'DRAFT') AS draft,
            COUNT(*) FILTER (WHERE ar.status = 'SUBMITTED') AS submitted,
            COUNT(*) FILTER (WHERE ar.status = 'APPROVED') AS approved,
            COUNT(*) FILTER (WHERE ar.status = 'MINTED') AS minted
          FROM candidate.assessment_records ar
          JOIN candidate.candidates cand
            ON cand.candidate_id = ar.candidate_id
          GROUP BY cand.testing_hub_id
        ) a ON a.testing_hub_id = h.hub_id
        ORDER BY h.hub_id
      `)
    ]);

  const u = users.rows[0];
  const a = assessments.rows[0];
  const l = credentials.rows[0];
  const q = queue.rows[0];

  return {
    // Shape documented in frontend guide #7.
    users: {
      total: u.total,
      superAdmins: u.super_admins,
      centerSuperintendents: u.center_superintendents,
      tradeTesters: u.trade_testers,
      activeMfa: u.active_mfa,
      pendingMfa: u.pending_mfa,
      adminLocked: u.admin_locked,
      activeUsers: u.active_users
    },
    sessions: { activeCount: sessions.rows[0].active_count },
    candidates: {
      totalEnrolled: candidates.rows[0].total_enrolled,
      verifiedCnic: candidates.rows[0].total_enrolled
    },
    assessments: {
      totalAssessed: a.total_assessed,
      draft: a.draft,
      submitted: a.submitted,
      approved: a.approved,
      minted: a.minted,
      rejected: a.rejected
    },
    ledger: {
      totalCredentials: l.total_credentials,
      pendingApproval: l.pending_approval,
      approved: l.approved,
      mintedOnChain: l.minted_on_chain,
      revoked: l.revoked,
      queuePending: q.queue_pending,
      queueFailed: q.queue_failed,
      queueMinted: q.queue_minted,
      queueTotal: q.queue_total
    },
    hubs: hubs.rows.map((h) => ({
      hubLocationId: h.hub_id,
      enrolled: h.enrolled,
      assessed: h.assessed,
      draft: h.draft,
      submitted: h.submitted,
      approved: h.approved,
      minted: h.minted
    })),

    // Legacy flat keys kept so nothing built on the old response breaks.
    total_users: u.total,
    super_admins: u.super_admins,
    superintendents: u.center_superintendents,
    trade_testers: u.trade_testers
  };
};

// --------------------------------------------------
// LIST USERS
// --------------------------------------------------

const listUsers = async ({
  limit = 50,
  offset = 0,
  role,
  search
}) => {
  const values = [];
  const conditions = [];

  if (role) {
    values.push(role);
    conditions.push(`role = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(email ILIKE $${values.length} OR role::text ILIKE $${values.length})`
    );
  }

  values.push(limit);
  const limitParam = `$${values.length}`;

  values.push(offset);
  const offsetParam = `$${values.length}`;

  const result = await pool.query(
    `
      SELECT
        user_id,
        email,
        role,
        hub_location_id,
        is_active,
        is_mfa_active,
        mfa_enrollment_pending,
        admin_locked,
        failed_login_attempts,
        locked_until,
        created_at
      FROM auth.users
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    values
  );

  return result.rows;
};

const countUsers = async ({ role, search }) => {
  const values = [];
  const conditions = [];

  if (role) {
    values.push(role);
    conditions.push(`role = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(email ILIKE $${values.length} OR role::text ILIKE $${values.length})`
    );
  }

  const result = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM auth.users
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    `,
    values
  );

  return result.rows[0].total;
};

// --------------------------------------------------
// AUDIT LOGS
// --------------------------------------------------

const getRecentAuditLogs = async (limit = 50) => {
  const result = await pool.query(
    `
      SELECT
        audit_id,
        user_id,
        event_type,
        email,
        ip_address,
        details,
        created_at
      FROM auth.audit_logs
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
};

// --------------------------------------------------
// ACTIVE SESSIONS
// --------------------------------------------------

const listActiveSessions = async (limit = 100) => {
  const result = await pool.query(
    `
      SELECT
        s.session_id,
        s.user_id,
        u.email,
        u.role,
        u.hub_location_id,
        s.ip_address,
        s.device_fingerprint,
        s.expires_at
      FROM auth.sessions s
      JOIN auth.users u ON u.user_id = s.user_id
      WHERE s.revoked = FALSE
        AND s.expires_at > NOW()
      ORDER BY s.expires_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
};

// --------------------------------------------------
// REVOKE A SESSION
// --------------------------------------------------

const revokeSessionById = async (sessionId) => {
  const result = await pool.query(
    `
      UPDATE auth.sessions
      SET revoked = TRUE
      WHERE session_id = $1
        AND revoked = FALSE
      RETURNING session_id, user_id
    `,
    [sessionId]
  );

  return result.rows[0] || null;
};

// --------------------------------------------------
// GET USER DETAILS
// --------------------------------------------------

const getUserById = async (userId) => {
  const result = await pool.query(
    `
      SELECT
        user_id,
        email,
        role,
        hub_location_id,
        is_active,
        is_mfa_active,
        mfa_enrollment_pending,
        admin_locked,
        token_version,
        failed_login_attempts,
        locked_until,
        created_at
      FROM auth.users
      WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

// --------------------------------------------------
// SESSIONS + AUDIT FOR ONE USER (user detail screen)
// --------------------------------------------------

const listSessionsByUser = async (userId, limit = 20) => {
  const result = await pool.query(
    `
      SELECT
        session_id,
        ip_address,
        device_fingerprint,
        expires_at
      FROM auth.sessions
      WHERE user_id = $1
        AND revoked = FALSE
        AND expires_at > NOW()
      ORDER BY expires_at DESC
      LIMIT $2
    `,
    [userId, limit]
  );

  return result.rows;
};

const getRecentAuditForUser = async (userId, limit = 20) => {
  const result = await pool.query(
    `
      SELECT
        audit_id,
        user_id,
        event_type,
        email,
        ip_address,
        details,
        created_at
      FROM auth.audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [userId, limit]
  );

  return result.rows;
};

// --------------------------------------------------
// MINTING QUEUE (Super Admin monitor)
// --------------------------------------------------

const listMintingQueue = async ({ limit = 50, status } = {}) => {
  const result = await pool.query(
    `
      SELECT
        q.id,
        q.credential_id,
        q.status,
        q.tx_hash,
        q.attempt_count,
        q.last_error,
        q.created_at,
        q.updated_at,
        c.status AS credential_status,
        cand.full_name AS candidate_name,
        cand.trade_category,
        cand.testing_hub_id
      FROM ledger.minting_queue q
      JOIN ledger.credentials c
        ON c.credential_id = q.credential_id
      JOIN candidate.candidates cand
        ON cand.candidate_id = c.candidate_id
      WHERE ($2::text IS NULL OR q.status = $2)
      ORDER BY q.created_at DESC
      LIMIT $1
    `,
    [limit, status || null]
  );

  return result.rows;
};

// --------------------------------------------------
// CREATE A MANAGED USER
// The MFA secret must be encrypted by the service
// before it is passed to this function.
// --------------------------------------------------

const createManagedUser = async ({
  email,
  password,
  role,
  hubLocationId,
  encryptedMfaSecret
}) => {
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        INSERT INTO auth.users (
          email,
          password_hash,
          role,
          hub_location_id,
          mfa_secret,
          is_mfa_active,
          mfa_enrollment_pending,
          admin_locked,
          token_version,
          failed_login_attempts,
          failed_mfa_attempts
        )
        VALUES ($1, $2, $3, $4, $5, FALSE, TRUE, FALSE, 0, 0, 0)
        RETURNING
          user_id,
          email,
          role,
          hub_location_id,
          is_mfa_active,
          mfa_enrollment_pending,
          admin_locked,
          created_at
      `,
      [
        email,
        passwordHash,
        role,
        hubLocationId,
        encryptedMfaSecret
      ]
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

// --------------------------------------------------
// LOCK OR UNLOCK A USER
// --------------------------------------------------

const setAdminLock = async (userId, locked) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          admin_locked = $2,
          token_version = token_version + 1
        WHERE user_id = $1
        RETURNING
          user_id,
          email,
          role,
          admin_locked,
          token_version
      `,
      [userId, locked]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query('ROLLBACK');
      return null;
    }

    // Invalidate refresh sessions for both lock and unlock actions.
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
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// RESET MFA
// A fresh encrypted secret is required.
// Existing backup codes and sessions are invalidated.
// --------------------------------------------------

const resetUserMfa = async (userId, encryptedMfaSecret) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          mfa_secret = $2,
          is_mfa_active = FALSE,
          mfa_enrollment_pending = TRUE,
          failed_mfa_attempts = 0,
          token_version = token_version + 1
        WHERE user_id = $1
        RETURNING
          user_id,
          email,
          role,
          is_mfa_active,
          mfa_enrollment_pending,
          token_version
      `,
      [userId, encryptedMfaSecret]
    );

    const user = result.rows[0];

    if (!user) {
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

    await client.query(
      `DELETE FROM auth.backup_codes WHERE user_id = $1`,
      [userId]
    );

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// SECURITY USER LOOKUP
// --------------------------------------------------

const getSecurityUserById = async (userId) => {
  const result = await pool.query(
    `
      SELECT
        user_id,
        email,
        role,
        hub_location_id,
        admin_locked,
        is_active,
        token_version,
        is_mfa_active,
        mfa_enrollment_pending
      FROM auth.users
      WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] || null;
};

// --------------------------------------------------
// CHECK DUPLICATE EMAIL
// --------------------------------------------------

const emailExists = async (email) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM auth.users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  return result.rowCount > 0;
};

// --------------------------------------------------
// DEVICE MANAGEMENT
// --------------------------------------------------

const registerAuthorizedDevice = async ({
  hubLocationId,
  deviceName,
  deviceFingerprint,
  deviceCredentialHash
}) => {
  const result = await pool.query(
    `
      INSERT INTO auth.authorized_devices (
        hub_location_id,
        device_name,
        device_fingerprint,
        device_credential_hash
      )
      VALUES ($1, $2, $3, $4)
      RETURNING
        device_id,
        hub_location_id,
        device_name,
        device_fingerprint,
        edr_status,
        revoked,
        created_at
    `,
    [
      hubLocationId,
      deviceName,
      deviceFingerprint,
      deviceCredentialHash
    ]
  );

  return result.rows[0];
};

const listAuthorizedDevices = async ({
  hubLocationId,
  limit = 50,
  offset = 0
}) => {
  const result = await pool.query(
    `
      SELECT
        device_id,
        hub_location_id,
        device_name,
        device_fingerprint,
        edr_status,
        last_heartbeat_at,
        revoked,
        revoked_at,
        created_at,
        updated_at
      FROM auth.authorized_devices
      WHERE ($1::INTEGER IS NULL OR hub_location_id = $1)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
    [hubLocationId ?? null, limit, offset]
  );

  return result.rows;
};

const revokeAuthorizedDevice = async (deviceId) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        UPDATE auth.authorized_devices
        SET
          revoked = TRUE,
          revoked_at = COALESCE(revoked_at, NOW()),
          updated_at = NOW()
        WHERE device_id = $1
          AND revoked = FALSE
        RETURNING
          device_id,
          hub_location_id,
          device_name,
          device_fingerprint
      `,
      [deviceId]
    );

    const device = result.rows[0];

    if (!device) {
      await client.query('ROLLBACK');
      return null;
    }

    // Revoke sessions associated with this device and hub.
    await client.query(
      `
        UPDATE auth.sessions s
        SET revoked = TRUE
        FROM auth.users u
        WHERE s.user_id = u.user_id
          AND u.hub_location_id = $1
          AND s.device_fingerprint = $2
          AND s.revoked = FALSE
      `,
      [
        device.hub_location_id,
        device.device_fingerprint
      ]
    );

    await client.query('COMMIT');

    return device;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// DEVICE HEALTH
// device_credential_hash is intentionally not selected.
// --------------------------------------------------

async function getDeviceHealth(hubLocationId = null) {
  const result = await pool.query(
    `SELECT
       device_id,
       hub_location_id,
       device_name,
       edr_status,
       last_heartbeat_at,
       revoked,
       created_at
     FROM auth.authorized_devices
     WHERE ($1::INTEGER IS NULL OR hub_location_id = $1)
     ORDER BY hub_location_id, device_name`,
    [hubLocationId]
  );

  return result.rows;
}

// --------------------------------------------------
// HUB DEVICE LOCKDOWN
// Upserts the lockdown state for a hub.
// --------------------------------------------------

const setHubLockdown = async (hubLocationId, isLocked, lockedBy) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        INSERT INTO auth.hub_device_lockdowns
          (hub_location_id, is_locked, locked_by, locked_at, updated_at)
        VALUES
          ($1, $2, $3, CASE WHEN $2 THEN NOW() ELSE NULL END, NOW())
        ON CONFLICT (hub_location_id)
        DO UPDATE SET
          is_locked = EXCLUDED.is_locked,
          locked_by = EXCLUDED.locked_by,
          locked_at = CASE
            WHEN EXCLUDED.is_locked THEN NOW()
            ELSE NULL
          END,
          updated_at = NOW()
        RETURNING
          hub_location_id,
          is_locked,
          locked_by,
          locked_at,
          updated_at
      `,
      [hubLocationId, isLocked, lockedBy]
    );

    // When lockdown is enabled, revoke all active sessions
    // belonging to users assigned to this hub.
    if (isLocked) {
      await client.query(
        `
          UPDATE auth.sessions s
          SET revoked = TRUE
          FROM auth.users u
          WHERE s.user_id = u.user_id
            AND u.hub_location_id = $1
            AND u.role <> 'SUPER_ADMIN'
            AND s.revoked = FALSE
        `,
        [hubLocationId]
      );
    }

    await client.query('COMMIT');

    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// B4: CHANGE USER ROLE
// --------------------------------------------------

const changeUserRole = async (
  userId, role, hubLocationId, adminUserId, ipAddress
) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Serialize changes that could affect the last active Super Admin.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('nsp-super-admin-protection'))`
    );

    const targetResult = await client.query(
      `
        SELECT user_id, email, role, hub_location_id, is_active
        FROM auth.users
        WHERE user_id = $1
        FOR UPDATE
      `,
      [userId]
    );

    const target = targetResult.rows[0];

    if (!target) {
      await client.query('ROLLBACK');
      return null;
    }

    if (
      target.role === 'SUPER_ADMIN' &&
      role !== 'SUPER_ADMIN' &&
      target.is_active
    ) {
      const countResult = await client.query(
        `
          SELECT COUNT(*)::int AS total
          FROM auth.users
          WHERE role = 'SUPER_ADMIN'
            AND is_active = TRUE
        `
      );

      if (countResult.rows[0].total <= 1) {
        const error = new Error(
          'The last active Super Admin cannot be demoted'
        );
        error.statusCode = 403;
        throw error;
      }
    }

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          role = $2,
          hub_location_id = $3,
          token_version = token_version + 1
        WHERE user_id = $1
        RETURNING
          user_id, email, role, hub_location_id,
          is_active, admin_locked, token_version
      `,
      [userId, role, hubLocationId]
    );

    await client.query(
      `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE user_id = $1 AND revoked = FALSE
      `,
      [userId]
    );

    await createAuditLog({
      userId: adminUserId,
      eventType: 'SUPER_ADMIN_USER_ROLE_CHANGED',
      ipAddress,
      details: {
        targetUserId: result.rows[0].user_id,
        previousRole: target.role,
        newRole: result.rows[0].role,
        previousHubLocationId: target.hub_location_id,
        newHubLocationId: result.rows[0].hub_location_id
      },
      client
    });

    await client.query('COMMIT');
    return { previous: target, user: result.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// B4: REASSIGN USER HUB
// --------------------------------------------------

const reassignUserHub = async (
  userId, hubLocationId, adminUserId, ipAddress
) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const previousResult = await client.query(
      `SELECT hub_location_id FROM auth.users WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );

    const targetHubLocationId = previousResult.rows[0]?.hub_location_id;

    if (targetHubLocationId === undefined) {
      await client.query('ROLLBACK');
      return null;
    }

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          hub_location_id = $2,
          token_version = token_version + 1
        WHERE user_id = $1
          AND role IN ('TRADE_TESTER', 'CENTER_SUPERINTENDENT')
        RETURNING
          user_id, email, role, hub_location_id,
          is_active, token_version
      `,
      [userId, hubLocationId]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE user_id = $1 AND revoked = FALSE
      `,
      [userId]
    );

    await createAuditLog({
      userId: adminUserId,
      eventType: 'SUPER_ADMIN_USER_HUB_REASSIGNED',
      ipAddress,
      details: {
        targetUserId: user.user_id,
        targetRole: user.role,
        previousHubLocationId: targetHubLocationId,
        newHubLocationId: user.hub_location_id
      },
      client
    });

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// B4: DEACTIVATE / REACTIVATE USER
// --------------------------------------------------

const setUserActiveStatus = async (
  userId, isActive, adminUserId, ipAddress
) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('nsp-super-admin-protection'))`
    );

    const targetResult = await client.query(
      `
        SELECT user_id, email, role, hub_location_id, is_active
        FROM auth.users
        WHERE user_id = $1
        FOR UPDATE
      `,
      [userId]
    );

    const target = targetResult.rows[0];

    if (!target) {
      await client.query('ROLLBACK');
      return null;
    }

    if (
      target.role === 'SUPER_ADMIN' &&
      target.is_active &&
      !isActive
    ) {
      const countResult = await client.query(
        `
          SELECT COUNT(*)::int AS total
          FROM auth.users
          WHERE role = 'SUPER_ADMIN'
            AND is_active = TRUE
        `
      );

      if (countResult.rows[0].total <= 1) {
        const error = new Error(
          'The last active Super Admin cannot be deactivated'
        );
        error.statusCode = 403;
        throw error;
      }
    }

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          is_active = $2,
          token_version = token_version + 1
        WHERE user_id = $1
        RETURNING
          user_id, email, role, hub_location_id,
          is_active, token_version
      `,
      [userId, isActive]
    );

    // Revoke sessions on deactivation and on reactivation so
    // the user must authenticate again after either transition.
    await client.query(
      `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE user_id = $1 AND revoked = FALSE
      `,
      [userId]
    );

    await createAuditLog({
      userId: adminUserId,
      eventType: isActive
        ? 'SUPER_ADMIN_USER_REACTIVATED'
        : 'SUPER_ADMIN_USER_DEACTIVATED',
      ipAddress,
      details: {
        targetUserId: result.rows[0].user_id,
        targetEmail: result.rows[0].email,
        targetRole: result.rows[0].role,
        previousIsActive: target.is_active,
        newIsActive: result.rows[0].is_active
      },
      client
    });

    await client.query('COMMIT');
    return { previous: target, user: result.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// B4: ADMIN PASSWORD RESET
// --------------------------------------------------

const resetUserPassword = async (
  userId, newPassword, adminUserId, ipAddress
) => {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `
        UPDATE auth.users
        SET
          password_hash = $2,
          token_version = token_version + 1
        WHERE user_id = $1
        RETURNING
          user_id, email, role, hub_location_id,
          is_active, token_version
      `,
      [userId, passwordHash]
    );

    const user = result.rows[0];

    if (!user) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `
        UPDATE auth.sessions
        SET revoked = TRUE
        WHERE user_id = $1 AND revoked = FALSE
      `,
      [userId]
    );

    await createAuditLog({
      userId: adminUserId,
      eventType: 'SUPER_ADMIN_USER_PASSWORD_RESET',
      ipAddress,
      details: {
        targetUserId: user.user_id,
        targetEmail: user.email,
        targetRole: user.role
      },
      client
    });

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  getDashboardStats,
  listUsers,
  countUsers,
  getRecentAuditLogs,
  listSessionsByUser,
  getRecentAuditForUser,
  listMintingQueue,
  listActiveSessions,
  revokeSessionById,
  getUserById,
  createManagedUser,
  setAdminLock,
  resetUserMfa,
  getSecurityUserById,
  emailExists,
  registerAuthorizedDevice,
  listAuthorizedDevices,
  revokeAuthorizedDevice,
  getDeviceHealth,
  setHubLockdown,
  changeUserRole,
  reassignUserHub,
  setUserActiveStatus,
  resetUserPassword
};