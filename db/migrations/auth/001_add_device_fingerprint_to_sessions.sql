-- Migration: Add device_fingerprint column to auth.sessions
-- Phase 1: Logging-only device fingerprinting (FR-AUTH-04)
-- Safe to run multiple times (IF NOT EXISTS guard).

ALTER TABLE auth.sessions
    ADD COLUMN IF NOT EXISTS device_fingerprint VARCHAR(255);

COMMENT ON COLUMN auth.sessions.device_fingerprint IS
    'SHA-256 hash of client device fingerprint (from x-device-fingerprint header). '
    'NULL for sessions created before fingerprinting was introduced. '
    'Used for Phase 1 anomaly logging; Phase 2 will enforce strict binding.';
