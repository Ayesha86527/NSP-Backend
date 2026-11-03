BEGIN;

-- B4: Separate account activation status from security locking.
ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_auth_users_active_role
    ON auth.users (role, is_active);

COMMIT;
