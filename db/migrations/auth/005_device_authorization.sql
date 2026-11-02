BEGIN;

-- Registered and authorized testing-hub laptops.
CREATE TABLE IF NOT EXISTS auth.authorized_devices (
    device_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hub_location_id INTEGER NOT NULL
        CHECK (hub_location_id BETWEEN 1 AND 5),
    device_name VARCHAR(100) NOT NULL,
    device_fingerprint VARCHAR(255) NOT NULL,
    device_credential_hash VARCHAR(64) NOT NULL UNIQUE,
    edr_status VARCHAR(20) NOT NULL DEFAULT 'unknown'
        CHECK (edr_status IN ('unknown', 'compliant', 'non_compliant')),
    last_heartbeat_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_authorized_device_hub_fingerprint
        UNIQUE (hub_location_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_authorized_devices_hub
    ON auth.authorized_devices(hub_location_id);

CREATE INDEX IF NOT EXISTS idx_authorized_devices_heartbeat
    ON auth.authorized_devices(last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_authorized_devices_active
    ON auth.authorized_devices(hub_location_id, revoked)
    WHERE revoked = FALSE;

-- Explicit lockdown state for each testing hub.
CREATE TABLE IF NOT EXISTS auth.hub_device_lockdowns (
    hub_location_id INTEGER PRIMARY KEY
        CHECK (hub_location_id BETWEEN 1 AND 5),
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    locked_by UUID REFERENCES auth.users(user_id) ON DELETE SET NULL,
    locked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
