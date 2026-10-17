# Ledger Module — Frontend Integration and Testing

**Audience:** NSP issuer-portal and verifier frontend developers  
**Status:** Issue, approval, status, and on-chain verification endpoints are implemented with role middleware. Configure the ledger database and blockchain environment, run the [AWS RDS migration](./ledger-postgres-aws-migration.md), and follow the readiness checks below before deployment.

## 1. What the module does

The current flow is:

1. The issuer frontend submits a candidate ID and credential subject to the API.
2. The backend creates a W3C-style credential, calculates a SHA-256 hash, and stores it in PostgreSQL.
3. An authenticated `CENTER_SUPERINTENDENT` or `SUPER_ADMIN` approves the credential. The backend records the approver and adds the credential to the minting queue.
4. The server's relayer checks the queue every 30 seconds and submits the credential ID and hash to the configured smart contract.
5. A verifier can ask the backend to check the credential on-chain.

Issuing a credential does **not** mint it immediately. The queue and relayer run asynchronously.

## 2. API

Use the backend base URL for the current environment, for example `http://localhost:3000` in local development. All routes below are mounted under `/api/ledger`. Protected routes require `Authorization: Bearer <accessToken>` from the existing login/MFA flow.

### Issue a credential

`POST /api/ledger/issue` — `201 Created`, `TRADE_TESTER`

Request:

```json
{
  "candidateId": "<candidate UUID>",
  "credentialSubject": {
    "skillName": "Electrical Installation",
    "issuer": "did:nsp:issuer:<issuer-id>",
    "awardLevel": "Level 2"
  }
}
```

`candidateId` must be a valid UUID for an existing candidate. `credentialSubject` must be a JSON object containing non-empty string `skillName` and `issuer` values; each is limited to 500 characters and the complete subject is limited to 16 KB. Additional JSON subject fields are included in the generated credential. Do not send an `id` property in `credentialSubject`; the backend constructs that field from `candidateId`. Validation failures return `400`; a candidate that does not exist returns `404`.

Success response:

```json
{
  "success": true,
  "message": "Credential successfully issued and stored (Pending Approval).",
  "data": {
    "credential_id": "urn:uuid:<generated UUID>",
    "candidate_id": "<candidate UUID>",
    "credential_subject": {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://schema.nsp.gov.pk/contexts/v1.json"
      ],
      "id": "urn:uuid:<generated UUID>",
      "type": ["VerifiableCredential", "NationalSkillsCredential"],
      "issuer": "did:nsp:issuer:<issuer-id>",
      "issuanceDate": "<ISO-8601 timestamp>",
      "credentialSubject": {
        "id": "did:nsp:candidate:<candidate UUID>",
        "skillName": "Electrical Installation",
        "issuer": "did:nsp:issuer:<issuer-id>",
        "awardLevel": "Level 2"
      }
    },
    "root_hash": "0x<64 hex characters>",
    "issued_at": "<database timestamp>",
    "status": "PENDING_APPROVAL"
  }
}
```

The returned database row uses `snake_case` for its database columns. Keep the complete `credential_id` string for subsequent approval and verification; the server derives the blockchain ID from that string.

Validation failures return `400` with `{ "success": false, "error": "<message>" }`.

### Approve and queue

`POST /api/ledger/approve` — `200 OK`, `CENTER_SUPERINTENDENT` or `SUPER_ADMIN`

Request:

```json
{
  "credentialId": "urn:uuid:<generated UUID>"
}
```

On success, `data` is the mint-queue row, including its `credential_id`, `payload`, and `status` (initially `QUEUED`). The queue row is **not** proof of a successful blockchain transaction. The relayer may take up to about 30 seconds to pick it up; transaction submission can take longer.

Malformed IDs return `400`; an unknown credential returns `404`; revoked credentials return `409`; server/database failures return a generic `500` response. Repeating approval is idempotent for queued, broadcast, and minted rows. An approval after a `FAILED` queue item deliberately resets its retry counter and re-queues the credential.

### Read credential and minting status

`GET /api/ledger/:credentialId` — `200 OK`, authenticated

The issuing `TRADE_TESTER` can read their own credential; a `CENTER_SUPERINTENDENT` can read credentials for their hub; `SUPER_ADMIN` can read across hubs. Other users, out-of-hub records, and unknown IDs receive `404`. The response contains credential status, minting status (when queued), issue/approval times, transaction hash, and attempt count, but not the credential subject:

```json
{
  "success": true,
  "data": {
    "credential_id": "urn:uuid:<generated UUID>",
    "credential_status": "APPROVED",
    "issued_at": "<timestamp>",
    "approved_at": "<timestamp>",
    "minting_status": "QUEUED",
    "tx_hash": null,
    "attempt_count": 0
  }
}
```

### Verify on-chain

`GET /api/ledger/verify/:credentialId` — public read endpoint; no token required

Example:

```text
GET /api/ledger/verify/urn:uuid:<generated UUID>
```

When the credential has been minted and is valid:

```json
{
  "success": true,
  "verified": true,
  "data": {
    "credentialId": "urn:uuid:<generated UUID>",
    "issuedAt": "<ISO-8601 timestamp>",
    "onChainHash": "0x<64 hex characters>"
  }
}
```

An unknown or invalid credential returns `404` with `success: false` and `verified: false`. This endpoint checks the chain; it does not return the stored credential document or mint-queue status.

## 3. Frontend implementation notes

- Treat issuance and approval as separate UI actions/states. An issued credential is `PENDING_APPROVAL`; a queued credential is not yet confirmed on-chain.
- Preserve the exact credential ID returned by `POST /issue`. Do not replace it with the candidate ID or generate a second ID in the browser.
- After approval, show a pending state and poll the authenticated status endpoint for queue state and transaction hash. A public verifier can call the verify endpoint after some delay, but until minting succeeds it will return `404`.
- The verify endpoint is suitable for a public verification screen. Do not expose private keys or perform signing in the browser.
- Treat HTTP `401` as an expired or missing login and `403` as a role that cannot perform that action.
- Issuers can only issue credentials for candidates assigned to their hub. Center Superintendents can only approve/read credentials for candidates in their hub; `SUPER_ADMIN` can operate across hubs.
- The status endpoint exposes one credential at a time; there is no endpoint to list a candidate's credentials or revoke a credential.
- Credentials can exhaust the five automatic mint attempts. An authorized approver can explicitly re-approve a failed credential to reset the attempt counter; show a clear retry confirmation rather than silently retrying.

## 4. Testing

### Smart-contract tests

From the repository root:

```sh
cd contract
npm install
npx hardhat test
```

These tests exercise contract deployment, authorization, minting, verification, and revocation on Hardhat's local network. They do **not** test the backend routes, PostgreSQL, relayer, or a deployed Polygon Amoy contract.

### Ledger service and middleware tests

From the repository root:

```sh
node --test test/ledger.service.test.js
```

These tests cover input validation, canonical hashing, issuer-hub candidate scoping, and role-guard behavior. They do not replace an API-to-PostgreSQL-to-chain integration test.

### Manual API smoke test

Apply the ledger schema to a disposable test database using [`001_create_ledger_tables.sql`](../db/migrations/ledger/001_create_ledger_tables.sql). Configure the backend `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` values for that database and set `DB_SSL=true` (plus `DB_SSL_CA` when using an explicit RDS CA file). Set the test-chain values `POLYGON_AMOY_RPC_URL`, `RELAYER_PRIVATE_KEY`, and `CERTIFICATE_LOGIC_CONTRACT_ADDRESS`, then start the API:

```sh
npm install
npm run dev
```

In a separate terminal, issue a credential and save the returned `credential_id`:

```sh
curl -i -X POST http://localhost:3000/api/ledger/issue \
  -H "Authorization: Bearer <TRADE_TESTER_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"candidateId":"<existing candidate UUID>","credentialSubject":{"skillName":"Electrical Installation","issuer":"did:nsp:issuer:test","awardLevel":"Level 2"}}'
```

Approve it using that exact ID:

```sh
curl -i -X POST http://localhost:3000/api/ledger/approve \
  -H "Authorization: Bearer <CENTER_SUPERINTENDENT_OR_SUPER_ADMIN_ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"credentialId":"urn:uuid:<generated UUID>"}'
```

Poll the authenticated status endpoint while the relayer processes the queue:

```sh
curl -i "http://localhost:3000/api/ledger/urn:uuid:<generated UUID>" \
  -H "Authorization: Bearer <ISSUER_OR_PRIVILEGED_ACCESS_TOKEN>"
```

After minting, verify publicly:

```sh
curl -i "http://localhost:3000/api/ledger/verify/urn:uuid:<generated UUID>"
```

Expected results: issue returns `201` and `PENDING_APPROVAL`; approve returns `200` and a `QUEUED` row; status eventually reports `MINTED`; verify returns `200` with `verified: true` only after a successful mint. Verify returns `404` while the credential is waiting or if minting failed.

The root package currently has no backend test script or ledger API/DB integration-test harness. This manual smoke test is therefore still required for deployment-level validation.

## 5. Integration readiness

Check these operational items before frontend work goes live:

1. **Role provisioning:** Trade Testers and Center Superintendents can log in; `SUPER_ADMIN` can also log in and approve ledger credentials. Confirm the intended admin user exists and has completed MFA setup.
2. **Database schema:** apply and verify the [AWS RDS ledger migration](./ledger-postgres-aws-migration.md) using the correct RDS database, then configure the backend environment without committing secrets.
3. **Blockchain configuration:** configure `POLYGON_AMOY_RPC_URL`, `RELAYER_PRIVATE_KEY`, and `CERTIFICATE_LOGIC_CONTRACT_ADDRESS` for a test deployment before the smoke test. The backend now fails explicitly if required chain settings are missing; never ship the signing key to the frontend.
4. **Revocation:** the contract supports revocation, but there is no backend ledger revocation endpoint. Do not expose revocation controls until the backend workflow is implemented.

Do not use real candidate or personal data in local-chain smoke tests.
