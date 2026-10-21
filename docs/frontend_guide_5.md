# NSP — Frontend Integration Guide #5

**Audience:** Frontend teams (Issuer Portal, Verifier DApp, and Worker Mobile Wallet)  
**Supersedes:** Guide #4 — read this as a **delta**. Everything in Guide 4 (Auth lifecycle, rotating token refresh, backup codes, account lockout) remains active and valid.  
**What's new since Guide 4:** The **Blockchain Minting & Ledger Module is now LIVE**. The backend now issues W3C Verifiable Credentials (`POST /api/ledger/issue`), enqueues them for on-chain anchoring (`POST /api/ledger/approve`), runs an automatic background relayer to Polygon Amoy testnet, exposes live minting status with transaction hashes (`GET /api/ledger/:credentialId`), and opens the **Public On-Chain Verification API** (`GET /api/ledger/verify/:credentialId`), unlocking the **Verifier DApp** and **Worker Wallet QR verification**.  
**Still not ready:** Super Admin system-wide hub configuration screens (IP-11 – IP-13), native push notifications.

---

## ⚠️ Outdated sections in Guide 4

| Guide 4 said | Now true in Guide 5 |
| --- | --- |
| "Minting status & blockchain receipts: ⏳ In Progress (ledger module under construction)" | **LIVE.** Full issuance, approval, mint queue, and transaction receipt tracking are live under `/api/ledger`. See §1 – §4. |
| "Public verification API: ⏳ In Progress (Verifier DApp on hold)" | **LIVE.** `GET /api/ledger/verify/:credentialId` is live, unauthenticated, and queries Polygon on-chain directly. See §5. |
| "`MINTED` status won't appear yet" | **LIVE.** The backend relayer polls the queue every 30s, mints via smart contract on Polygon, and updates status to `MINTED` with `tx_hash`. |
| "Super Admin screens: ⛔ Wait" | **Partial Live.** `SUPER_ADMIN` can now log in, review credentials across all hubs, and trigger ledger approvals. |

---

## 1. End-to-End Credential & Minting Architecture

The credential lifecycle now spans off-chain intake, cryptographic compilation, and on-chain Layer-2 Polygon anchoring:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              ISSUER PORTAL (Trade Tester)                              │
│  Candidate Intake ──► Assessment Scoring ──► POST /api/ledger/issue                    │
│                       (Status: PENDING_APPROVAL, W3C VC Compiled, SHA-256 Calculated)  │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          ISSUER PORTAL (Superintendent / Admin)                        │
│  Review Submitted Credential ──► POST /api/ledger/approve                              │
│                                  (Status: QUEUED in ledger.minting_queue)              │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       AUTOMATIC BACKEND RELAYER (Every 30s Loop)                       │
│  Claims QUEUED item ──► Ethers.js ──► Polygon Amoy Contract (mintCertificate)           │
│  Tx Confirmed ──► Status: MINTED, tx_hash stamped                                      │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   VERIFIER DApp / WORKER WALLET (Public Employers)                     │
│  Scan QR Code / Enter ID ──► GET /api/ledger/verify/:credentialId (Zero Auth)          │
│  Direct Polygon Amoy Contract Call ──► { verified: true, onChainHash, issuedAt }       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

> **Key Takeaway for Frontend:** Issuance does **not** mint immediately. The approval queues the credential, and the backend relayer mints asynchronously on the blockchain. The frontend should display a pending state and poll for completion.

---

## 2. Issue a Credential (`POST /api/ledger/issue`)

* **Screen:** Issuer Portal — Trade Tester Final Sign-Off (IP-07 / IP-10)
* **Access:** `Authorization: Bearer <accessToken>`
* **Allowed Roles:** `TRADE_TESTER` only (`403` otherwise)
* **Hub Scoping:** The backend validates that the `candidateId` belongs to the Trade Tester's assigned hub (`user.hubLocationId`). Passing a candidate from another hub returns `404 Not Found`.

### 2.1 Request Body
```json
{
  "candidateId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "credentialSubject": {
    "skillName": "Electrical Installation & Maintenance",
    "issuer": "did:nsp:hub:peshawar-01",
    "awardLevel": "Level 2 (Skilled)",
    "practicalScore": 88.5,
    "theoryScore": 92.0
  }
}
```

#### Validation Rules:
* `candidateId`: Required, valid UUID string format (`400` if invalid).
* `credentialSubject`: Required JSON object (max size **16 KB**).
* `credentialSubject.skillName`: Required non-empty string, max 500 characters.
* `credentialSubject.issuer`: Required non-empty string (DID format e.g. `did:nsp:...`), max 500 characters.
* **Do NOT send `id` inside `credentialSubject`:** The server derives this automatically as `did:nsp:candidate:<candidateId>`. Including `id` in the request returns `400`.

### 2.2 Success Response (`201 Created`)
```json
{
  "success": true,
  "message": "Credential issued and stored pending approval.",
  "data": {
    "credential_id": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "candidate_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "created_by": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "credential_subject": {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://schema.nsp.gov.pk/contexts/v1.json"
      ],
      "id": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "type": [
        "VerifiableCredential",
        "NationalSkillsCredential"
      ],
      "issuer": "did:nsp:hub:peshawar-01",
      "issuanceDate": "2026-10-18T10:15:30.123Z",
      "credentialSubject": {
        "id": "did:nsp:candidate:3fa85f64-5717-4562-b3fc-2c963f66afa6",
        "skillName": "Electrical Installation & Maintenance",
        "issuer": "did:nsp:hub:peshawar-01",
        "awardLevel": "Level 2 (Skilled)",
        "practicalScore": 88.5,
        "theoryScore": 92.0
      }
    },
    "root_hash": "0x5a1f8c...32bytesHex...",
    "issued_at": "2026-10-18T10:15:30.123Z",
    "status": "PENDING_APPROVAL"
  }
}
```

> **CRITICAL FRONTEND CONTRACT:** Save the full `credential_id` string (`urn:uuid:...`). This canonical URN is the exact identifier required for approval, status polling, and public verification.

---

## 3. Approve Credential & Queue for Minting (`POST /api/ledger/approve`)

* **Screen:** Issuer Portal — Superintendent Approval Queue (IP-09 / IP-10)
* **Access:** `Authorization: Bearer <accessToken>`
* **Allowed Roles:** `CENTER_SUPERINTENDENT` or `SUPER_ADMIN` (`403` otherwise)
* **Hub Scoping:** Center Superintendents can only approve credentials belonging to their assigned hub. `SUPER_ADMIN` can approve across all hubs.

### 3.1 Request Body
```json
{
  "credentialId": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

### 3.2 Success Response (`200 OK`)
```json
{
  "success": true,
  "message": "Credential approved and added to the blockchain minting queue.",
  "data": {
    "id": 14,
    "credential_id": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "payload": {
      "credentialId": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "rootHash": "0x5a1f8c...32bytesHex...",
      "w3cCredential": { ... }
    },
    "status": "QUEUED",
    "tx_hash": null,
    "attempt_count": 0,
    "created_at": "2026-10-18T10:18:00.000Z"
  }
}
```

#### Idempotency & Retry Semantics:
* **Already Queued / Broadcasted / Minted:** Calling approve again is completely safe (idempotent) and returns the existing queue state without duplicating transactions.
* **Failed Mints Reset:** If a credential previously reached `FAILED` status (e.g. temporary blockchain network partition), re-submitting approval automatically resets `attempt_count: 0` and re-queues it as `QUEUED`.

---

## 4. Check Credential & Minting Status (`GET /api/ledger/:credentialId`)

* **Screen:** Issuer Portal — Assessment / Credential Status Monitor (IP-10)
* **Access:** `Authorization: Bearer <accessToken>`
* **Allowed Roles:** `TRADE_TESTER`, `CENTER_SUPERINTENDENT`, `SUPER_ADMIN`
* **Access Rules:** Trade Testers can view their own credentials; Superintendents can view all credentials in their hub; Super Admins can view any credential.

### 4.1 Endpoint URL
`GET /api/ledger/urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7`

### 4.2 Response States

#### State A: Approved & Queued (Awaiting Blockchain Relayer)
```json
{
  "success": true,
  "data": {
    "credential_id": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "credential_status": "APPROVED",
    "issued_at": "2026-10-18T10:15:30.123Z",
    "approved_at": "2026-10-18T10:18:00.000Z",
    "minting_status": "QUEUED",
    "tx_hash": null,
    "attempt_count": 0
  }
}
```

#### State B: Confirmed on Blockchain (`MINTED`)
```json
{
  "success": true,
  "data": {
    "credential_id": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "credential_status": "APPROVED",
    "issued_at": "2026-10-18T10:15:30.123Z",
    "approved_at": "2026-10-18T10:18:00.000Z",
    "minting_status": "MINTED",
    "tx_hash": "0x89abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    "attempt_count": 1
  }
}
```

### 4.3 UI Mapping (Status Badges)

| `minting_status` | UI Badge / Display | Permitted Actions |
| :--- | :--- | :--- |
| `null` | 🟡 **Pending Approval** | Superintendent: Approve button |
| `"QUEUED"` | 🔵 **Queued for Minting** | Show spinner / "Anchoring to Blockchain..." |
| `"BROADCASTED"` | 🟣 **Broadcasting (Polygon)** | Show spinner / "Awaiting Block Confirmation..." |
| `"MINTED"` | 🟢 **Anchored on Blockchain** | Show Polygon Tx link, enable Certificate View & QR code |
| `"FAILED"` | 🔴 **Minting Failed** | Show "Retry Minting" button (re-calls `/api/ledger/approve`) |

---

## 5. Public On-Chain Verification API (`GET /api/ledger/verify/:credentialId`)

* **Audience:** Verifier DApp (Screens VD-01 – VD-04) & Worker Mobile Wallet (WW-04)
* **Access:** **PUBLIC — ZERO AUTHENTICATION REQUIRED** (No Bearer token, no cookies, no login barrier).
* **Mechanism:** The backend directly invokes the `verifyCertificate(bytes32 certId)` view method on the Polygon Amoy smart contract via ethers.js.

### 5.1 Endpoint URL
`GET /api/ledger/verify/urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7`

### 5.2 Success Response (`200 OK` — Valid on Blockchain)
```json
{
  "success": true,
  "verified": true,
  "data": {
    "credentialId": "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "issuedAt": "2026-10-18T10:18:32.000Z",
    "onChainHash": "0x5a1f8c...32bytesHex..."
  }
}
```

### 5.3 Failure Response (`404 Not Found` — Unminted, Tampered, or Revoked)
```json
{
  "success": false,
  "verified": false,
  "message": "Credential not found, revoked, or invalid on-chain."
}
```

### 5.4 Verifier DApp UI Implementation Recipe (React / Vue / Mobile)

```ts
interface VerificationResult {
  verified: boolean;
  credentialId?: string;
  issuedAt?: string;
  onChainHash?: string;
  errorMessage?: string;
}

export async function verifyNspCredential(credentialId: string): Promise<VerificationResult> {
  try {
    const res = await fetch(`https://api.nsp.gov.pk/api/ledger/verify/${encodeURIComponent(credentialId)}`);
    const json = await res.json();

    if (res.status === 200 && json.verified) {
      return {
        verified: true,
        credentialId: json.data.credentialId,
        issuedAt: json.data.issuedAt,
        onChainHash: json.data.onChainHash
      };
    } else {
      return {
        verified: false,
        errorMessage: json.message || "Credential is not valid or has been revoked."
      };
    }
  } catch (err: any) {
    return {
      verified: false,
      errorMessage: "Network error connecting to the verification node."
    };
  }
}
```

---

## 6. Frontend Polling & Transition Guidelines

Because the background relayer ticks every **30 seconds**:
1. When a Superintendent clicks **"Approve"**, update the local UI card status immediately to `QUEUED`.
2. Start polling `GET /api/ledger/:credentialId` every **5 seconds**.
3. Once `data.minting_status === "MINTED"`:
   * Stop polling.
   * Display a success toast: *"Credential anchored on Polygon blockchain!"*
   * Link the transaction hash to PolygonScan:
     `https://amoy.polygonscan.com/tx/${data.tx_hash}`
4. If polling exceeds 90 seconds without transitioning to `MINTED`, slow down the poll interval to 15 seconds. If `data.minting_status === "FAILED"`, present a *"Retry Approval"* action.

---

## 7. Error Codes Cheat Sheet (Ledger & Verification)

| Endpoint | Status | Error Condition | Recommended UI Action |
| :--- | :--- | :--- | :--- |
| `/api/ledger/issue` | `400` | Missing required fields, invalid UUID, or client-provided `id` | Show field-level form validation error. |
| `/api/ledger/issue` | `404` | Candidate does not exist or belongs to another hub | Show "Candidate not found in your testing hub". |
| `/api/ledger/issue` | `403` | User missing hub location or not `TRADE_TESTER` | Restrict action in navigation. |
| `/api/ledger/approve` | `400` | Malformed `credentialId` (not a valid `urn:uuid:...`) | Validate ID format before sending. |
| `/api/ledger/approve` | `404` | Credential not found or belongs to another hub | Display error banner on approval modal. |
| `/api/ledger/approve` | `409` | Credential has been marked `REVOKED` | Show *"Revoked credentials cannot be approved"*. |
| `/api/ledger/:id` | `404` | Credential not found or unauthorized cross-hub read | Display 404 state card. |
| `/api/ledger/verify/:id` | `404` | Not yet minted on-chain, hash mismatch, or revoked | Show prominent **"NOT VERIFIED / INVALID"** red badge. |
| Any route | `429` | Global rate limit exceeded (60 req/min) | Show cooldown timer toast. |

---

## 8. Build-Now / Wait Table (Master Status for Guide 5)

| Application / Module | Screens | Status | Action for Frontend Teams |
| :--- | :--- | :--- | :--- |
| **Verifier DApp** | VD-01 – VD-04 | 🟢 **FULL GREEN (BUILD NOW)** | Build QR scanner + Manual ID lookup with `GET /api/ledger/verify/:id` (§5). |
| **Worker Mobile Wallet** | WW-01 – WW-05 | 🟢 **FULL GREEN (BUILD NOW)** | Generate QR code encoding `urn:uuid:...` and display verification badge. |
| **Ledger Credential Issuance** | IP-07 / IP-10 | 🟢 **BUILD NOW** | Connect final assessment sign-off to `POST /api/ledger/issue` (§2). |
| **Superintendent Ledger Approval**| IP-09 / IP-10 | 🟢 **BUILD NOW** | Wire queue approval to `POST /api/ledger/approve` (§3). |
| **Blockchain Status & Receipts** | IP-10 | 🟢 **BUILD NOW** | Implement status badge, polling, and PolygonScan links (§4). |
| **Token Refresh & Rotation** | Global Auth | 🟢 Ready (Guide 4) | Active in production. |
| **Server-Side Revocation / Logout**| Global Auth | 🟢 Ready (Guide 4) | Active in production. |
| **Backup Codes (MFA Fallback)** | IP-03 | 🟢 Ready (Guide 4) | Active in production. |
| **Super Admin Full Dashboard** | IP-11 – IP-13 | ⏳ **In Development** | Scheduled for next milestone. |

---

*Guide #5 generated against backend commit `9cd826d` ("ledger module is completed"). All endpoints, contracts, and JSON envelopes verified against the active codebase.*
