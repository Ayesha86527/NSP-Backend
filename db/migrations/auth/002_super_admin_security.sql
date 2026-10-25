BEGIN;

ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS admin_locked BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mfa_enrollment_pending BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_auth_users_email_lower
    ON auth.users (LOWER(email));

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
    ON auth.sessions (user_id, revoked, expires_at);

COMMIT;