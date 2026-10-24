
-- NSP Backend — Day 4 schema migration
-- Compatibility-first bootstrap DDL for auth, candidate, and ledger.
-- Existing tables are not altered by CREATE TABLE IF NOT EXISTS.

BEGIN;

-- Part 1: Schemas and enum types
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS candidate;
CREATE SCHEMA IF NOT EXISTS ledger;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'auth'
          AND t.typname = 'user_role'
    ) THEN
        CREATE TYPE auth.user_role AS ENUM (
            'TRADE_TESTER',
            'CENTER_SUPERINTENDENT',
            'SUPER_ADMIN'
        );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'candidate'
          AND t.typname = 'assessment_status'
    ) THEN
        CREATE TYPE candidate.assessment_status AS ENUM (
            'DRAFT',
            'SUBMITTED',
            'APPROVED',
            'REJECTED',
            'MINTED'
        );
    END IF;
END
$$;

-- Part 2: Auth tables
CREATE TABLE IF NOT EXISTS auth.users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role auth.user_role NOT NULL,
    hub_location_id INTEGER CHECK (hub_location_id BETWEEN 1 AND 5),
    mfa_secret VARCHAR(255) NOT NULL,
    is_mfa_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    failed_mfa_attempts INTEGER NOT NULL DEFAULT 0,
    admin_locked BOOLEAN NOT NULL DEFAULT FALSE,
    token_version INTEGER NOT NULL DEFAULT 0,
    mfa_enrollment_pending BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS auth.sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL
        REFERENCES auth.users(user_id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    device_fingerprint VARCHAR(255),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS auth.backup_codes (
    backup_code_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL
        REFERENCES auth.users(user_id) ON DELETE CASCADE,
    code_hash VARCHAR(255) NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.audit_logs (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID
        REFERENCES auth.users(user_id) ON DELETE SET NULL,
    event_type VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    ip_address VARCHAR(45),
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Part 3: Candidate tables
CREATE TABLE IF NOT EXISTS candidate.candidates (
    candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(255) NOT NULL,
    father_name VARCHAR(255) NOT NULL,
    dob DATE NOT NULL,
    cnic_salted_hash VARCHAR(64) UNIQUE NOT NULL,
    cnic_dedup_hash VARCHAR(64) UNIQUE NOT NULL,
    cnic_blind_salt VARCHAR(255) NOT NULL,
    photo_s3_uri VARCHAR(512) NOT NULL,
    trade_category VARCHAR(100) NOT NULL,
    testing_hub_id INTEGER NOT NULL
        CHECK (testing_hub_id BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS candidate.assessment_records (
    assessment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL
        REFERENCES candidate.candidates(candidate_id) ON DELETE RESTRICT,
    score NUMERIC(5,2) NOT NULL,
    grade VARCHAR(10) NOT NULL,
    tester_user_id UUID NOT NULL
        REFERENCES auth.users(user_id),
    superintendent_user_id UUID
        REFERENCES auth.users(user_id),
    status candidate.assessment_status NOT NULL DEFAULT 'DRAFT',
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    client_request_id UUID
);

CREATE TABLE IF NOT EXISTS candidate.assessment_media (
    media_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    assessment_id UUID NOT NULL
        REFERENCES candidate.assessment_records(assessment_id)
        ON DELETE CASCADE,
    media_type VARCHAR(255) NOT NULL,
    media_s3_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Part 4: Ledger tables
-- Preserve existing credential and minting-queue names/statuses.
CREATE TABLE IF NOT EXISTS ledger.credentials (
    credential_id TEXT PRIMARY KEY
        CHECK (credential_id ~ '^urn:uuid:[0-9a-fA-F-]{36}$'),
    candidate_id UUID NOT NULL
        REFERENCES candidate.candidates(candidate_id) ON DELETE RESTRICT,
    created_by UUID,
    approved_by UUID,
    credential_subject JSONB NOT NULL,
    root_hash TEXT NOT NULL
        CHECK (root_hash ~ '^0x[0-9a-fA-F]{64}$'),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
        CHECK (status IN (
            'PENDING_APPROVAL', 'APPROVED', 'MINTED', 'REVOKED'
        )),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger.minting_queue (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    credential_id TEXT NOT NULL UNIQUE
        REFERENCES ledger.credentials(credential_id) ON DELETE RESTRICT,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'BROADCASTED', 'CONFIRMED', 'MINTED', 'FAILED')),
    tx_hash TEXT
        CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Part 5: Indexes
CREATE INDEX IF NOT EXISTS idx_backup_codes_unused
    ON auth.backup_codes (user_id, used_at)
    WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_backup_codes_user_id
    ON auth.backup_codes (user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
    ON auth.sessions (user_id, revoked, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_users_email_lower
    ON auth.users (LOWER(email));

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_tester_client_request
    ON candidate.assessment_records (tester_user_id, client_request_id)
    WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS credentials_candidate_id_idx
    ON ledger.credentials (candidate_id, issued_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS minting_queue_credential_id_uidx
    ON ledger.minting_queue (credential_id);

CREATE INDEX IF NOT EXISTS minting_queue_pending_idx
    ON ledger.minting_queue (status, created_at)
    WHERE status IN ('QUEUED', 'FAILED', 'BROADCASTED');

COMMIT;
