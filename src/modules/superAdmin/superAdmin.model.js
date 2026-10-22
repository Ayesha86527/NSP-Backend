const pool = require('../../config/db');
const bcrypt = require('bcrypt');

// --------------------------------------------------
// DASHBOARD
// --------------------------------------------------

const getDashboardStats = async () => {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COUNT(*) FILTER (
        WHERE role = 'SUPER_ADMIN'
      )::int AS super_admins,
      COUNT(*) FILTER (
        WHERE role = 'CENTER_SUPERINTENDENT'
      )::int AS superintendents,
      COUNT(*) FILTER (
        WHERE role = 'TRADE_TESTER'
      )::int AS trade_testers
    FROM auth.users
  `);

  return result.rows[0];
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
        is_mfa_active,
        mfa_enrollment_pending,
        admin_locked,
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
// EXPORTS
// --------------------------------------------------

module.exports = {
  getDashboardStats,
  listUsers,
  getRecentAuditLogs,
  listActiveSessions,
  revokeSessionById,
  getUserById,
  createManagedUser,
  setAdminLock,
  resetUserMfa,
  getSecurityUserById,
  emailExists
};
