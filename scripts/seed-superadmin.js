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
    await pool.query(
      `UPDATE auth.users 
       SET password_hash = $1, 
           role = 'SUPER_ADMIN', 
           is_active = true, 
           admin_locked = false, 
           is_mfa_active = false,
           mfa_enrollment_pending = true,
           failed_login_attempts = 0,
           locked_until = null,
           mfa_locked_until = null
       WHERE email = $2`,
      [hash, ADMIN_EMAIL]
    );
    console.log('✅ Super Admin account updated successfully!');
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
  console.log('MFA:       Enrollment required on first login (QR Code)');
  console.log('--------------------------------------------------');
  
  await pool.end();
}

seedSuperAdmin().catch((err) => {
  console.error('Error seeding super admin:', err.message);
  process.exit(1);
});
