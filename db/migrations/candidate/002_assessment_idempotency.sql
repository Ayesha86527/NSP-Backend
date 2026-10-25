
-- Track B Phase 2: prevent duplicate assessment creation
-- when a tester retries the same client request.

CREATE UNIQUE INDEX IF NOT EXISTS
    assessment_records_tester_client_request_uidx
ON candidate.assessment_records (
    tester_user_id,
    client_request_id
)
WHERE client_request_id IS NOT NULL;
