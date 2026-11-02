# NSP — Frontend Integration Guide #8

**Audience:** Frontend teams (Trade Tester Portal, Center Superintendent Portal, Super Admin Portal, Public Verifier)  
**Document Version:** 1.0.0 (Capstone Release)  
**Supersedes:** Guide #7 — read this as a **delta and capstone guide**. Guides 1 through 7 remain active and authoritative for their respective domains. Guide 8 documents all recent backend security architectures, newly added endpoints, error handling contracts, and deployment integration matrices.

---

## 📋 Executive Summary of Recent Additions & Updates

Since Guide #7, the backend has implemented major security features and API contracts across Track B Phases 1 & 2:

1. **Step-Up MFA Authorization (B1 - `POST /api/auth/step-up`):** An elevated authorization system that issues short-lived (5-minute), single-use RS256 JWT tokens passed via the `x-step-up-token` header for high-security actions.
2. **Self-Service User Profile Management (B2 - `GET /api/auth/profile`):** Authenticated users across all roles can view their safe profile metadata without exposing credential hashes.
3. **Self-Service Password Rotation (B2 - `PATCH /api/auth/profile`):** Secure password update requiring validation of the current password, triggering real-time `token_version` invalidation across other active sessions.
4. **Self-Service Active Sessions Explorer (B2 - `GET /api/auth/sessions`):** Real-time visibility into all active device sessions for the authenticated user, identifying `is_current: true`.
5. **Refresh Token Reuse Detection & Family Revocation (B2):** Automatic mitigation of token replay and theft. Reusing an already-rotated refresh token instantly revokes the entire session family with audit logging (`AUTH_REFRESH_TOKEN_REUSE_DETECTED`).
6. **60-Candidate Enrolment Hub Quota Enforcement (FR-CAND-01):** PostgreSQL advisory-locked hub capacity check returning structured HTTP `409 Conflict`.
7. **Production Ledger Bridge Contract (`assessment.approved`):** Clarification on how Superintendent approvals automatically enqueue credentials for Polygon Amoy minting.
8. **Final Deployment Matrix & Environment Variables:** Authoritative configuration reference for staging and AWS production deployment.

---

## 1. Step-Up MFA Authorization Architecture (B1)

Certain sensitive actions (e.g., approving an assessment, revoking credentials, resetting MFA) require re-verification of the user's secondary factor even if they already possess an active session.

### 1.1 Step-Up Workflow Sequence

```
┌────────────────────────────────────────────────────────────────────────┐
│                   1. User Attempts Sensitive Action                    │
│      (e.g., ApprovalsScreen -> Click "Approve & Issue to Ledger")      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Frontend Checks Action Policy or Backend Returns 401:               │
│ {                                                                      │
│   "success": false,                                                    │
│   "message": "Step-up authentication token is required"                │
│ }                                                                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Frontend Displays Step-Up Challenge Modal:                          │
│ Prompts user for 6-digit TOTP code (or 8-character backup code)        │
│ Calls POST /api/auth/step-up                                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Backend Verifies Code and Issues Single-Use Step-Up Token:          │
│ Returns 200 OK:                                                        │
│ {                                                                      │
│   "success": true,                                                     │
│   "stepUpToken": "<RS256 JWT, 5-min expiry, specific scope>",          │
│   "scope": "APPROVE_ASSESSMENT",                                       │
│   "expiresIn": 300                                                     │
│ }                                                                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Frontend Retries Sensitive Action with Header:                      │
│ POST /api/assessments/:id/approve                                      │
│ Headers: {                                                             │
│   "Authorization": "Bearer <accessToken>",                             │
│   "x-step-up-token": "<stepUpToken>"                                   │
│ }                                                                      │
│ Backend verifies & consumes the single-use token (jti marked used).    │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Step-Up Token Request (`POST /api/auth/step-up`)

* **Authentication:** Requires valid user session (`Bearer <accessToken>`).
* **Header:** `Authorization: Bearer <accessToken>`
* **Request Body:** Must provide `scope` and **either** `mfaCode` or `backupCode` (never both or neither).

```http
POST /api/auth/step-up
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "scope": "APPROVE_ASSESSMENT",
  "mfaCode": "482910"
}
```

* **Supported Scopes:**
  * `'APPROVE_ASSESSMENT'` — For Superintendent assessment approvals.
  * `'REVOKE_CREDENTIAL'` — For credential revocations.
  * `'REGISTER_HUB_KEY'` — For cryptographic hub key registration.
  * `'CHANGE_ROLE'` — For staff role modifications.
  * `'RESET_MFA'` — For administrative MFA resets.

* **Success Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Step-up authentication successful",
  "stepUpToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInNpZCI6InNlc3MtNDU2IiwicHVycG9zZSI6InN0ZXBfdXAiLCJzY29wZSI6IkFQUFJPVkVfQVNTRVNTTUVOVCIsImp0aSI6ImVjY2Y4NzFkLTY3ODgtNGU5My1iOGI4LWU2ZjQyMjRmMDAwYyIsImlhdCI6MTczMDU1MjQwMCwiZXhwIjoxNzMwNTUyNzAwfQ...",
  "scope": "APPROVE_ASSESSMENT",
  "expiresIn": 300
}
```

* **Error Responses:**
  * `400 Bad Request`: `{ "success": false, "message": "Provide exactly one MFA code or backup code" }` or `{ "success": false, "message": "Valid scope is required" }`
  * `401 Unauthorized`: `{ "success": false, "message": "Invalid MFA code" }` (or invalid backup code)
  * `403 Forbidden`: `{ "success": false, "message": "Token scope does not authorize this action" }`
  * `423 Locked`: `{ "success": false, "message": "Account temporarily locked due to too many failed MFA attempts. Try again in 15 minutes." }`

> [!IMPORTANT]
> **Single-Use Enforcement:** Each step-up token has a unique `jti` claim recorded in the database. When consumed by a protected route, it is marked `used = true`. Any attempt to replay the same step-up token will fail with `401 Unauthorized` (`"Step-up token has already been used"`).

---

## 2. User Profile & Password Management (B2)

Located in `src/modules/auth/auth.routes.js`, all authenticated users can now manage their account profile and password independently.

### 2.1 Get Current User Profile (`GET /api/auth/profile`)

* **Authentication:** `Bearer <accessToken>`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "profile": {
    "user_id": "c8a4df54-3236-4767-9bf4-0f2c7320b3a4",
    "email": "ahmad.raza@navttc.gov.pk",
    "name": "Ahmad Raza",
    "role": "TRADE_TESTER",
    "hub_id": 1,
    "is_mfa_active": true,
    "mfa_enrollment_pending": false,
    "admin_locked": false,
    "last_login": "2026-11-01T08:30:00.000Z",
    "created_at": "2026-01-15T10:00:00.000Z"
  }
}
```
*(Notice: Sensitive fields like `password_hash`, `mfa_secret`, and backup codes are strictly excluded).*

### 2.2 Change Password (`PATCH /api/auth/profile`)

Used by users to rotate their own password from `SettingsScreen.tsx`.

* **Authentication:** `Bearer <accessToken>`
* **Request Body:** Must contain exactly `currentPassword` and `newPassword`.

```http
PATCH /api/auth/profile
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "currentPassword": "OldPassword123!",
  "newPassword": "NewStrongPassword456!"
}
```

* **Validation Rules:**
  * `newPassword` must be at least 8 characters.
  * `newPassword` must differ from `currentPassword`.
  * `currentPassword` must match the stored bcrypt hash.

* **Success Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Password updated successfully"
}
```

* **Error Responses:**
  * `400 Bad Request`: `{ "success": false, "message": "Only password changes are allowed in the profile" }` or `{ "success": false, "message": "New password must be at least 8 characters long" }` or `{ "success": false, "message": "New password cannot be the same as the current password" }`
  * `401 Unauthorized`: `{ "success": false, "message": "Current password is incorrect" }`

> [!NOTE]
> Changing the password increments `token_version` on the user record in PostgreSQL. All other active sessions and access tokens for this user on other devices are immediately rendered invalid.

---

## 3. User Self-Service Active Sessions Explorer (B2)

Authenticated users can inspect all devices and active sessions tied to their account (`GET /api/auth/sessions`).

### 3.1 List Active Sessions (`GET /api/auth/sessions`)

* **Authentication:** `Bearer <accessToken>`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "count": 2,
  "sessions": [
    {
      "session_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "device_fingerprint": "dfp_9a7b3c2d1e4f",
      "ip_address": "203.128.22.14",
      "created_at": "2026-11-01T08:00:00.000Z",
      "last_active": "2026-11-01T09:15:00.000Z",
      "expires_at": "2026-11-08T08:00:00.000Z",
      "is_current": true
    },
    {
      "session_id": "f9e8d7c6-b5a4-3210-fedc-ba9876543210",
      "device_fingerprint": "dfp_5f6e7d8c9b0a",
      "ip_address": "42.201.64.88",
      "created_at": "2026-10-30T14:22:00.000Z",
      "last_active": "2026-10-31T18:40:00.000Z",
      "expires_at": "2026-11-06T14:22:00.000Z",
      "is_current": false
    }
  ]
}
```

* **Frontend UI Implementation:** In `DevicesScreen.tsx` or `SettingsScreen.tsx`, render each session card with an "Active Now" badge on the session matching `is_current === true`. Users can terminate their own non-current sessions using `POST /api/auth/revoke`.

---

## 4. Refresh Token Reuse Detection & Session Family Revocation

To prevent credential replay and man-in-the-middle attacks, the backend now tracks refresh token lineages via `db/migrations/auth/004_refresh_token_reuse_detection.sql`.

### 4.1 How It Works

1. When `POST /api/auth/refresh` is called with a valid `refreshToken`, the backend:
   - Rotates the refresh token (generates a new cryptographically secure token).
   - Marks the old refresh token as `consumed = true`.
   - Issues new `accessToken` and `refreshToken` pair.
2. If an attacker intercepts and replays the **already consumed** old refresh token:
   - The backend detects that a consumed token was presented.
   - **Immediate Countermeasure:** The backend terminates the entire session family (`revoked = true`), bumps `token_version`, and logs an audit security event `AUTH_REFRESH_TOKEN_REUSE_DETECTED`.
   - Returns HTTP `401 Unauthorized`.

### 4.2 Frontend Interceptor Protocol

Update the API client (`src/services/api.ts`) response interceptor to handle session family termination:

```typescript
// src/services/api.ts interceptor
if (response.status === 401) {
  const errorData = await response.clone().json().catch(() => ({}));

  if (
    errorData.message?.includes("Invalid or expired refresh token") ||
    errorData.message?.includes("Session has been revoked") ||
    errorData.code === "TOKEN_FAMILY_REVOKED"
  ) {
    // Session compromised or revoked: clear state and redirect to login
    authStore.clear();
    window.location.href = "/login?reason=session_expired";
    return;
  }
}
```

---

## 5. Hub Candidate Enrolment Quota (FR-CAND-01)

As required by TOR FR-CAND-01, each testing hub has a strict enrolment limit of **60 candidates**.

### 5.1 Enrolment Error Contract (`POST /api/candidates`)

When attempting to enrol candidate #61 in a hub:

* **HTTP Status:** `409 Conflict`
* **Response Body:**
```json
{
  "success": false,
  "statusCode": 409,
  "message": "This testing hub has reached its maximum enrolment limit of 60 candidates"
}
```

### 5.2 Frontend UI Guidelines for `EnrollmentScreen.tsx`

1. **Catch HTTP 409 Specifically:**
```typescript
try {
  await api.enrolCandidate(payload);
  showToast("Candidate successfully enrolled", "success");
} catch (error: any) {
  if (error.statusCode === 409 || error.status === 409) {
    setQuotaExceededModalOpen(true);
    setErrorMessage("Testing Hub Quota Reached: Maximum 60 candidates have already enrolled in this hub.");
    return;
  }
  showToast(error.message || "Failed to enrol candidate", "error");
}
```

2. **Visual Indicators:**
   - Display a hub capacity progress meter (e.g. `48 / 60 Enrolled`).
   - Disable the "Register Candidate" submit button with a tooltip when the count reaches 60.

---

## 6. Assessment-to-Ledger Production Handshake

In Guide 5 and Guide 6, the assessment approval flow was described. Here is how the event bus is wired for automated Polygon Amoy issuance:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Superintendent Approves Assessment:                                 │
│    POST /api/assessments/:id/approve                                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Backend updates assessment_records status to 'APPROVED'             │
│    Emits Event: eventBus.emitSafely('assessment.approved', payload)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Ledger Listener intercepts payload:                                 │
│    Calls ledgerService.issueCredentialOnly(payload)                    │
│    Inserts entry into candidate.minting_queue (status: 'PENDING')      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Background Relayer (runs every 30s in app.js):                      │
│    Picks up 'PENDING' queue item -> Signs tx on Polygon Amoy           │
│    Stores polygon_tx_hash and block_number in DB                       │
│    Updates assessment status from 'APPROVED' -> 'MINTED'               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. Frontend CredentialsScreen:                                         │
│    Displays "MINTED" status with direct Polygonscan explorer link:     │
│    https://amoy.polygonscan.com/tx/0x...                               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Frontend Integration Code Examples

### 7.1 React Hook for Step-Up MFA (`useStepUp.ts`)

```typescript
import { useState } from 'react';
import { api } from '../services/api';

export function useStepUp() {
  const [isOpen, setIsOpen] = useState(false);
  const [scope, setScope] = useState<string>('');
  const [pendingAction, setPendingAction] = useState<((token: string) => Promise<void>) | null>(null);

  const requestElevation = (actionScope: string, action: (token: string) => Promise<void>) => {
    setScope(actionScope);
    setPendingAction(() => action);
    setIsOpen(true);
  };

  const submitStepUp = async (code: string, isBackup = false) => {
    const res = await api.post('/api/auth/step-up', {
      scope,
      ...(isBackup ? { backupCode: code } : { mfaCode: code }),
    });

    if (res.data?.stepUpToken && pendingAction) {
      await pendingAction(res.data.stepUpToken);
      setIsOpen(false);
      setPendingAction(null);
    }
  };

  return { isOpen, scope, requestElevation, submitStepUp, cancel: () => setIsOpen(false) };
}
```

### 7.2 Service Extensions for Profile & Sessions (`src/services/api.ts`)

```typescript
export interface UserProfile {
  user_id: string;
  email: string;
  name: string;
  role: 'TRADE_TESTER' | 'CENTER_SUPERINTENDENT' | 'SUPER_ADMIN';
  hub_id: number | null;
  is_mfa_active: boolean;
  last_login: string;
  created_at: string;
}

export interface UserSession {
  session_id: string;
  device_fingerprint: string;
  ip_address: string;
  created_at: string;
  last_active: string;
  expires_at: string;
  is_current: boolean;
}

export const profileApi = {
  // GET /api/auth/profile
  async getProfile(): Promise<UserProfile> {
    const res = await api.get<{ success: boolean; profile: UserProfile }>('/api/auth/profile');
    return res.data.profile;
  },

  // PATCH /api/auth/profile
  async updatePassword(currentPassword: string, newPassword: string): Promise<void> {
    await api.patch('/api/auth/profile', { currentPassword, newPassword });
  },

  // GET /api/auth/sessions
  async getSessions(): Promise<UserSession[]> {
    const res = await api.get<{ success: boolean; count: number; sessions: UserSession[] }>('/api/auth/sessions');
    return res.data.sessions;
  },
};
```

---

## 8. Complete Production Environment Variables Matrix

To ensure full compatibility with AWS deployments (EC2 + RDS + S3), verify that your frontend `.env.production` contains all necessary keys:

| Environment Variable | Description | Example Value |
|---|---|---|
| `VITE_API_BASE_URL` | Base URL for Backend API | `https://api.nsp.gov.pk` or `http://<EC2_PUBLIC_IP>:3000` |
| `VITE_RPC_URL` | Polygon Amoy Testnet RPC endpoint | `https://polygon-amoy.infura.io/v3/<INFURA_KEY>` |
| `VITE_VERIFIER_CONTRACT_ADDRESS` | Deployed `CertificateLogic` address on Polygon Amoy | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| `VITE_ENVIRONMENT` | Application deployment environment | `production` |

---

## 9. Final Pre-Flight Integration Checklist

Before initiating production user acceptance testing (UAT):

- [x] **Auth & MFA (FR-AUTH):** Login, TOTP verification, RS256 token exchange, backup codes, and 15-minute lockouts verified.
- [x] **Step-Up MFA (B1):** Protected actions challenge with `POST /api/auth/step-up` and pass `x-step-up-token`.
- [x] **Profile & Sessions (B2):** Self-service password rotation and active device session listing active.
- [x] **Candidate Enrolment (FR-CAND):** CNIC validation, pre-signed S3 photo upload, and 60-candidate quota 409 handling verified.
- [x] **Assessment & Idempotency (FR-ASSE):** Offline IndexedDB queue and `clientRequestId` deduplication active.
- [x] **Superintendent Queue (FR-ASSE):** Hub-filtered approvals and formal rejections returning assessments to DRAFT verified.
- [x] **Blockchain Ledger (FR-LEDG):** 30-second relayer cycle mints approved credentials to Polygon Amoy.
- [x] **Public Verification (FR-VERI):** Instant unauthenticated verification via QR scanner and Manual Entry screen working `< 2.0s`.
- [x] **Super Admin Portal (FR-ADMIN):** Provisioning, account freezing (`token_version`), MFA reset QR generation, and session killing functional.
