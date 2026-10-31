
BEGIN;

-- Dedicated MFA lockout; separate from password lockout.
ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS mfa_locked_until TIMESTAMPTZ;

-- Stores only SHA-256 hashes of step-up tokens.
CREATE TABLE IF NOT EXISTS auth.step_up_tokens (
    token_hash CHAR(64) PRIMARY KEY,

    user_id UUID NOT NULL
        REFERENCES auth.users(user_id) ON DELETE CASCADE,

    session_id UUID NOT NULL
        REFERENCES auth.sessions(session_id) ON DELETE CASCADE,

    scope VARCHAR(50) NOT NULL
        CHECK (scope IN (
            'APPROVE_ASSESSMENT',
            'REVOKE_CREDENTIAL',
            'REGISTER_HUB_KEY',
            'CHANGE_ROLE',
            'RESET_MFA'
        )),

    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_step_up_tokens_user_session
    ON auth.step_up_tokens (user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_step_up_tokens_expiry
    ON auth.step_up_tokens (expires_at);

COMMIT;
