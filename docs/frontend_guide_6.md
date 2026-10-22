# NSP — Frontend Integration Guide #6

**Audience:** Frontend teams (Issuer Portal, Superintendent Approval Dashboard, Verifier DApp, and Mobile Wallet)  
**Supersedes:** Guide #5 — read this as a **delta**. Everything in Guide 4 (Auth lifecycle, rotating token refresh, backup codes, account lockout) and Guide 5 (Ledger issuance, approval, and on-chain verification) remains active and valid.  
**What's new since Guide 5:**
1. **Device Fingerprinting (`FR-AUTH-04`) is LIVE:** Hub laptop binding via client-side fingerprinting is now implemented on the backend. The frontend must capture and send `x-device-fingerprint` across all auth endpoints.
2. **Candidate Assessment to Ledger Bridge:** Complete end-to-end integration specifications connecting Trade Tester assessment sign-off (`/api/candidate/assessments`) directly to Credential Issuance (`POST /api/ledger/issue`).
3. **Confirmed Architectural Directives (Supervisor Mandates):**
   * **NADRA API:** Supervisor confirmed external NADRA API integration is deferred at this stage. Format verification via mock provider is live; no changes needed in enrollment forms.
   * **Redis Cache:** Redis is strictly an optional performance cache layer. The system is 100% operational standalone with PostgreSQL + Polygon RPC.
4. **Role & Permission Unification:** `SUPER_ADMIN` is now officially enabled in the auth service and can review/approve credentials across all hubs.

---

## ⚠️ Summary of Changes Since Guide 5

| Guide 5 said | Now true in Guide 6 |
| --- | --- |
| "Device Fingerprinting: ⏳ Planning" | **LIVE.** Backend persists `device_fingerprint` in `auth.sessions` and audits session binding on every token refresh. See §1. |
| "Super Admin screens: Partial Live" | **Fully Unified.** `SUPER_ADMIN`, `CENTER_SUPERINTENDENT`, and `TRADE_TESTER` are fully authenticated with role-based hub scoping. |
| NADRA integration status unclear | **Clarified.** No external NADRA API at this stage; backend uses mock validation provider seamlessly. |
| Redis caching dependency unclear | **Clarified.** No Redis setup required for frontend dev/staging; backend operates standalone. |

---

## 1. Device Fingerprinting Integration (`FR-AUTH-04`)

To satisfy security requirement `FR-AUTH-04` (binding active assessment and administrative sessions to authorized hub laptops) without introducing paid SaaS subscriptions, the system uses **FingerprintJS Community Edition** (client-side open-source, 100% free, MIT licensed) coupled with backend session binding.

### 1.1 How It Works
```
┌──────────────────────────────────────────────┐
│             BROWSER (Frontend)               │
│  FingerprintJS.load() ──► visitorId (32-hex) │
└──────────────────────┬───────────────────────┘
                       │ HTTP Header: x-device-fingerprint: <visitorId>
                       ▼
┌──────────────────────────────────────────────┐
│             BACKEND (Express)                │
│  verifyMfa / verifyBackupCode                │
│  └── Persists device_fingerprint in DB       │
│  refreshAccessToken                          │
│  └── Compares incoming vs stored fingerprint │
│  └── Phase 1: Emits AUTH_DEVICE_MISMATCH log │
│      (Non-disruptive, allows refresh)        │
└──────────────────────────────────────────────┘
```

### 1.2 Frontend Package Installation
In your frontend project (`NSP-Webapp` or mobile webview):
```bash
npm install @fingerprintjs/fingerprintjs
```

### 1.3 Client Fingerprint Utility (`src/services/fingerprint.ts`)
Create a singleton helper so the browser fingerprint is computed once and cached in memory:

```ts
import FingerprintJS from '@fingerprintjs/fingerprintjs';

let cachedVisitorId: string | null = null;
let fpPromise: Promise<string> | null = null;

/**
 * Returns a stable, deterministic hardware/browser fingerprint (visitorId).
 * Safe for offline or restricted environments with a fallback.
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (cachedVisitorId) {
    return cachedVisitorId;
  }

  if (!fpPromise) {
    fpPromise = (async () => {
      try {
        const fp = await FingerprintJS.load();
        const result = await fp.get();
        cachedVisitorId = result.visitorId.toLowerCase().trim();
        return cachedVisitorId;
      } catch (error) {
        console.warn('[Fingerprint] Failed to generate client fingerprint; using fallback', error);
        // Fallback based on navigator and screen attributes
        const fallbackRaw = `${navigator.userAgent}|${screen.width}x${screen.height}|${navigator.language}`;
        cachedVisitorId = btoa(fallbackRaw).substring(0, 32).toLowerCase();
        return cachedVisitorId;
      }
    })();
  }

  return fpPromise;
}
```

### 1.4 Required Request Header
Include the `x-device-fingerprint` header in all requests made to:
* `POST /api/auth/login`
* `POST /api/auth/verify-mfa`
* `POST /api/auth/verify-backup-code`
* `POST /api/auth/refresh`

> **Note on Phase 1 Enforcement:** During Phase 1, the backend runs in **Audit-Only Mode**. If a device fingerprint changes (or header is missing), the backend logs `AUTH_DEVICE_MISMATCH` in the audit log for supervisor review but **will not disrupt or block** the user session. Strict rejection (`403 Forbidden`) will be enabled in Phase 2 after baseline testing.

---

## 2. End-to-End Assessment to Blockchain Issuance Workflow

The frontend workflow for assessing a candidate and converting passing scores into a verifiable credential on Polygon Amoy testnet is outlined below:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. TRADE TESTER (Screen IP-06): Record Assessment Scores                    │
│    POST /api/assessments                                          │
│    { candidateId, practicalScore: 85, theoryScore: 90, remarks: "Pass" }    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Assessment Saved (Status: COMPLETED)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. TRADE TESTER (Screen IP-07): Final Sign-Off & Credential Issuance        │
│    POST /api/ledger/issue                                                   │
│    { candidateId, credentialSubject: { skillName, awardLevel, ... } }       │
│    Backend compiles W3C VC, calculates root hash ──► Status: PENDING_APPROVAL│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Notification to Superintendent
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. CENTER SUPERINTENDENT (Screen IP-09): Review & Approval Queue            │
│    POST /api/ledger/approve                                                 │
│    { credentialId: "urn:uuid:..." }                                         │
│    Status moves to QUEUED in ledger.minting_queue                            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Relayer background loop (~30s)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. POLYGON AMOY TESTNET: Asynchronous Blockchain Anchoring                  │
│    Relayer calls CertificateStorage.mintCertificate(hash, candidateId, ...) │
│    Tx Confirmed ──► Status: MINTED with tx_hash                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Triggering Credential Issuance from Assessment (`POST /api/ledger/issue`)
* **Screen:** Assessment Result Review (IP-07)
* **Access:** `Authorization: Bearer <accessToken>` (`TRADE_TESTER` only)
* **Pre-condition:** Candidate must have passed assessment (Total Score >= 60%).

#### Request Example:
```json
POST /api/ledger/issue
Content-Type: application/json
Authorization: Bearer <accessToken>
x-device-fingerprint: <visitorId>

{
  "candidateId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "credentialSubject": {
    "skillName": "Solar PV Installation & Maintenance",
    "issuer": "did:nsp:hub:peshawar-01",
    "awardLevel": "Level 2 (Skilled)",
    "practicalScore": 88.0,
    "theoryScore": 92.5
  }
}
```

#### Response Example (`201 Created`):
```json
{
  "success": true,
  "message": "Credential issued and stored pending approval.",
  "data": {
    "credential_id": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
    "candidate_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "status": "PENDING_APPROVAL",
    "root_hash": "0x4b78c9...32bytes...",
    "issued_at": "2026-10-21T09:30:00.000Z"
  }
}
```

> **IMPORTANT:** Always store and reference the full `credential_id` (`urn:uuid:...`) in state. It is the canonical key for all subsequent approval and verification endpoints.

---

## 3. Superintendent Approval Queue & Live Minting Tracker

Center Superintendents and Super Admins approve credentials for on-chain anchoring.

### 3.1 Approve Credential (`POST /api/ledger/approve`)
* **Screen:** Superintendent Approval Queue (IP-09)
* **Allowed Roles:** `CENTER_SUPERINTENDENT`, `SUPER_ADMIN`

```json
POST /api/ledger/approve
Content-Type: application/json
Authorization: Bearer <accessToken>
x-device-fingerprint: <visitorId>

{
  "credentialId": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18"
}
```

### 3.2 Poll Credential & Minting Status (`GET /api/ledger/:credentialId`)
* **Screen:** Credential Detail & Blockchain Tracking (IP-10)
* **Access:** `Authorization: Bearer <accessToken>`

```json
GET /api/ledger/urn%3Auuid%3A8b3e811c-d7a8-4395-8147-380ff9ba7c18
Authorization: Bearer <accessToken>
```

#### Status State Machine for Frontend UI:
```json
{
  "success": true,
  "data": {
    "credential_id": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
    "candidate_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "credential_status": "APPROVED",
    "minting_status": "MINTED",
    "tx_hash": "0x3a4b5c6d...polygonTxHash...",
    "issued_at": "2026-10-21T09:30:00.000Z",
    "approved_at": "2026-10-21T09:32:00.000Z",
    "attempt_count": 1
  }
}
```

#### Status Badge Mapping:
| `credential_status` | `minting_status` | UI Badge | Description |
| :--- | :--- | :--- | :--- |
| `PENDING_APPROVAL` | `null` | 🟡 **Pending Approval** | Awaiting Center Superintendent sign-off |
| `APPROVED` | `"QUEUED"` | 🔵 **Queued for Blockchain** | In relayer queue; waiting for next batch |
| `APPROVED` | `"BROADCASTED"` | 🟣 **Mining on Polygon** | Transaction submitted to Polygon Amoy |
| `APPROVED` | `"MINTED"` | 🟢 **Anchored on Blockchain** | Confirmed on-chain; `tx_hash` available |
| `APPROVED` | `"FAILED"` | 🔴 **Minting Failed** | Relayer encountered gas/network error; will retry |

When `minting_status === "MINTED"`, render a direct link to PolygonScan:
```ts
const explorerUrl = `https://amoy.polygonscan.com/tx/${data.tx_hash}`;
```

---

## 4. Public Verifier DApp & QR Code Contract

The public verification endpoint requires **zero authentication** and allows employers, embassies, and regulatory authorities to verify candidate credentials directly against Polygon Amoy testnet.

### 4.1 Verification Endpoint (`GET /api/ledger/verify/:credentialId`)
* **Public Route:** No `Authorization` header required.
* **Query:** Passes canonical `credentialId` (e.g., `urn:uuid:...`).

#### Request:
```http
GET /api/ledger/verify/urn%3Auuid%3A8b3e811c-d7a8-4395-8147-380ff9ba7c18 HTTP/1.1
Host: api.nsp.gov.pk
```

#### Success Response (`200 OK` - Valid On-Chain Credential):
```json
{
  "success": true,
  "verified": true,
  "data": {
    "credentialId": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
    "issuedAt": "2026-10-21T09:30:00.000Z",
    "onChainHash": "0x4b78c92a10b80f2d4e8c1a7b...32bytes..."
  }
}
```

#### Failure Responses:
* **Unregistered / Not Minted (`404 Not Found`):**
  ```json
  {
    "success": false,
    "verified": false,
    "message": "Certificate not found or not yet anchored on-chain."
  }
  ```
* **Tampered / Hash Mismatch (`200 OK` with `verified: false`):**
  ```json
  {
    "success": true,
    "verified": false,
    "message": "Certificate hash mismatch. Credential data may have been altered."
  }
  ```

### 4.2 QR Code Payload Standard for Worker Certificates
When generating a QR code for printed certificates or mobile wallet displays, use the standard URL format:
```
https://verifier.nsp.gov.pk/verify?id=urn%3Auuid%3A8b3e811c-d7a8-4395-8147-380ff9ba7c18
```
The Verifier DApp extracts the `id` search param and calls `GET /api/ledger/verify/:credentialId`.

---

## 5. Architectural Baselines & Constraints

### 5.1 NADRA Verification
* **Supervisor Decision:** The external government NADRA API will not be integrated at this phase.
* **Backend Behavior:** The candidate module uses an internal format validation adapter (`nadra.service.js`) that simulates verification and marks candidates as verified (`provider: 'DEVELOPMENT'`).
* **Frontend Action:** Continue submitting CNIC format (`12345-1234567-1`) to `POST /api/candidates`. No third-party NADRA SDK or external biometric API is required on the frontend.

### 5.2 Redis Cache Status
* **Clarification:** Redis is purely an optional performance accelerator for caching public credential verification responses.
* **Frontend Action:** The frontend communicates directly with standard REST endpoints. If Redis is absent or stopped in the backend environment, all endpoints continue functioning normally without errors.

### 5.3 Account Lockout Protection Reminder
* 5 consecutive failed login attempts locks the account for **15 minutes**.
* The response will be `401 Unauthorized` with:
  ```json
  {
    "success": false,
    "message": "Account locked for 15 minutes due to too many failed login attempts."
  }
  ```
* The frontend login screen must display the lockout warning and disable retry buttons until the cooldown expires, or prompt the user to use an emergency backup code.

---

## 6. Complete Frontend API Client Recipe (`src/services/api.ts`)

Here is the complete, drop-in TypeScript implementation covering device fingerprinting, automatic silent token refresh, backup codes, ledger issuance, approval, and public verification:

```ts
import { getDeviceFingerprint } from './fingerprint';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

interface RequestOptions extends RequestInit {
  requiresAuth?: boolean;
}

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((promise) => {
    if (error) {
      promise.reject(error);
    } else {
      promise.resolve(token!);
    }
  });
  failedQueue = [];
};

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { requiresAuth = true, headers: customHeaders, ...restOptions } = options;
  const headers = new Headers(customHeaders);

  // 1. Attach Device Fingerprint to all requests
  const fingerprint = await getDeviceFingerprint();
  headers.set('x-device-fingerprint', fingerprint);

  // 2. Attach Authorization token if required
  let accessToken = localStorage.getItem('accessToken');
  if (requiresAuth && accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  if (!headers.has('Content-Type') && !(restOptions.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const config: RequestInit = {
    ...restOptions,
    headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

  // 3. Handle Token Expiration (401) with Silent Refresh
  if (response.status === 401 && requiresAuth && !endpoint.includes('/api/auth/')) {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) {
      handleSessionExpiry();
      throw new Error('Session expired. Please log in again.');
    }

    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newAccessToken) => {
        headers.set('Authorization', `Bearer ${newAccessToken}`);
        return fetch(`${API_BASE_URL}${endpoint}`, { ...restOptions, headers }).then((res) =>
          res.json()
        );
      });
    }

    isRefreshing = true;

    try {
      const refreshRes = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-fingerprint': fingerprint,
        },
        body: JSON.stringify({ refreshToken }),
      });

      const refreshData = await refreshRes.json();

      if (!refreshRes.ok || !refreshData.success) {
        throw new Error('Refresh token invalid or expired');
      }

      // Update tokens in local storage
      localStorage.setItem('accessToken', refreshData.accessToken);
      localStorage.setItem('refreshToken', refreshData.refreshToken);

      processQueue(null, refreshData.accessToken);

      // Retry original request with new token
      headers.set('Authorization', `Bearer ${refreshData.accessToken}`);
      const retryResponse = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...restOptions,
        headers,
      });
      return retryResponse.json();
    } catch (refreshErr) {
      processQueue(refreshErr, null);
      handleSessionExpiry();
      throw refreshErr;
    } finally {
      isRefreshing = false;
    }
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'API request failed');
  }

  return data as T;
}

function handleSessionExpiry() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  window.location.href = '/login';
}

// ======================================================
// TYPED API SERVICES
// ======================================================

export const ApiService = {
  // --- AUTHENTICATION ---
  login: (email: string, password: string) =>
    apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      requiresAuth: false,
    }),

  verifyMfa: (email: string, mfaCode: string) =>
    apiRequest('/api/auth/verify-mfa', {
      method: 'POST',
      body: JSON.stringify({ email, mfaCode }),
      requiresAuth: false,
    }),

  verifyBackupCode: (email: string, password: string, backupCode: string) =>
    apiRequest('/api/auth/verify-backup-code', {
      method: 'POST',
      body: JSON.stringify({ email, password, backupCode }),
      requiresAuth: false,
    }),

  revokeSession: () => {
    const refreshToken = localStorage.getItem('refreshToken');
    return apiRequest('/api/auth/revoke', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
  },

  getBackupCodeStatus: () =>
    apiRequest<{ success: boolean; totalCodes: number; unusedCodes: number; usedCodes: number }>(
      '/api/auth/backup-codes/status',
      { method: 'GET' }
    ),

  generateBackupCodes: () =>
    apiRequest<{ success: boolean; backupCodes: string[] }>(
      '/api/auth/backup-codes/generate',
      { method: 'POST' }
    ),

  // --- CANDIDATE & ASSESSMENT ---
  createCandidate: (candidateData: any) =>
    apiRequest('/api/candidates', {
      method: 'POST',
      body: JSON.stringify(candidateData),
    }),

  submitAssessment: (assessmentData: {
    candidateId: string;
    practicalScore: number;
    theoryScore: number;
    remarks?: string;
  }) =>
    apiRequest('/api/assessments', {
      method: 'POST',
      body: JSON.stringify(assessmentData),
    }),

  // --- LEDGER & BLOCKCHAIN ---
  issueCredential: (payload: {
    candidateId: string;
    credentialSubject: {
      skillName: string;
      issuer: string;
      awardLevel: string;
      practicalScore: number;
      theoryScore: number;
      [key: string]: any;
    };
  }) =>
    apiRequest('/api/ledger/issue', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  approveCredential: (credentialId: string) =>
    apiRequest('/api/ledger/approve', {
      method: 'POST',
      body: JSON.stringify({ credentialId }),
    }),

  getCredentialStatus: (credentialId: string) =>
    apiRequest(`/api/ledger/${encodeURIComponent(credentialId)}`, {
      method: 'GET',
    }),

  // --- PUBLIC VERIFICATION (Zero-Auth) ---
  verifyPublicCredential: (credentialId: string) =>
    apiRequest<{
      success: boolean;
      verified: boolean;
      data?: {
        credentialId: string;
        issuedAt: string;
        onChainHash: string;
      };
      message?: string;
    }>(`/api/ledger/verify/${encodeURIComponent(credentialId)}`, {
      method: 'GET',
      requiresAuth: false,
    }),
};
```

---

## 7. Frontend Team Implementation Checklist

- [ ] **Step 1:** Install `@fingerprintjs/fingerprintjs` and add `src/services/fingerprint.ts`.
- [ ] **Step 2:** Ensure `x-device-fingerprint` is passed in all auth and API headers.
- [ ] **Step 3:** Wire Assessment Scoring (IP-06) completion to trigger `ApiService.issueCredential()`.
- [ ] **Step 4:** Wire Superintendent Approval Queue (IP-09) to call `ApiService.approveCredential()`.
- [ ] **Step 5:** Update Credential Detail Screen (IP-10) with live status badge polling and PolygonScan tx explorer links.
- [ ] **Step 6:** Update Verifier DApp / QR reader to call public `ApiService.verifyPublicCredential()`.
- [ ] **Step 7:** Verify logout calls `ApiService.revokeSession()` to invalidate refresh tokens server-side.
