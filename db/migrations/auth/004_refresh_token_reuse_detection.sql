CREATE TABLE IF NOT EXISTS auth.refresh_token_history (
    token_hash VARCHAR(64) PRIMARY KEY,
    session_id UUID NOT NULL
        REFERENCES auth.sessions(session_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_history_session
    ON auth.refresh_token_history(session_id);