require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/config/db');

const ADMIN_EMAIL = 'superadmin@nsp.com';
const ADMIN_PASSWORD = 'SuperAdmin@123!';

async function seedSuperAdmin() {
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  
  const existing = await pool.query(
    'SELECT user_id FROM auth.users WHERE email = $1',
    [ADMIN_EMAIL]
  );

  if (existing.rowCount > 0) {
    // Re-running this script must NOT silently wipe a working MFA setup:
    // that forces a brand-new QR scan at the next login. MFA is reset only
    // when explicitly requested:  node scripts/seed-superadmin.js --reset-mfa
    const resetMfa = process.argv.includes('--reset-mfa');

    await pool.query(
      `UPDATE auth.users
       SET password_hash = $1,
           role = 'SUPER_ADMIN',
           is_active = true,
           admin_locked = false,
           failed_login_attempts = 0,
           locked_until = null,
           mfa_locked_until = null,
           is_mfa_active = CASE WHEN $3 THEN false ELSE is_mfa_active END,
           mfa_enrollment_pending = CASE WHEN $3 THEN true ELSE mfa_enrollment_pending END
       WHERE email = $2`,
      [hash, ADMIN_EMAIL, resetMfa]
    );
    console.log(
      resetMfa
        ? '✅ Super Admin updated and MFA reset (new QR scan required).'
        : '✅ Super Admin password/status updated. MFA left unchanged.'
    );
  } else {
    await pool.query(
      `INSERT INTO auth.users (
        email,
        password_hash,
        role,
        hub_location_id,
        is_active,
        is_mfa_active,
        mfa_enrollment_pending,
        admin_locked,
        failed_login_attempts
      )
      VALUES ($1, $2, 'SUPER_ADMIN', NULL, TRUE, FALSE, TRUE, FALSE, 0)`,
      [ADMIN_EMAIL, hash]
    );
    console.log('✅ Super Admin account created successfully!');
  }

  console.log('--------------------------------------------------');
  console.log('Email:    ', ADMIN_EMAIL);
  console.log('Password: ', ADMIN_PASSWORD);
  console.log('Role:      SUPER_ADMIN');
  console.log('MFA:       QR enrollment on first login only (use --reset-mfa to force again)');
  console.log('--------------------------------------------------');
  
  await pool.end();
}

seedSuperAdmin().catch((err) => {
  console.error('Error seeding super admin:', err.message);
  process.exit(1);
});