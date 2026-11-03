# NSP — Final Frontend Integration Guide (Capstone: Post-Guide #7)

**Audience:** All Frontend Engineering Teams (Trade Tester Portal, Center Superintendent Portal, Super Admin Portal, Public Verifier)  
**Document Version:** 2.0.0 (Final Comprehensive Capstone)  
**Context:** This is the **final, definitive frontend guide** covering all features, endpoints, and architectural changes merged after **Guide #7**. Guides 1 through 6 cover earlier modules (Enrolment, Scoring, Approvals, QR Verification, S3 uploads); Guide #7 covered basic Super Admin user provisioning and first-time MFA enrollment.  

This guide provides the complete specification for everything added since Guide #7:
1. **Step-Up MFA Authorization Engine (B1)**
2. **User Profile & Self-Service Password Rotation (B2)**
3. **User Active Sessions Explorer & Termination (B2)**
4. **Refresh Token Reuse Detection & Family Invalidation (B2)**
5. **60-Candidate Enrolment Hub Quota Enforcement (FR-CAND-01)**
6. **Device Authorization, Hardware Fingerprinting & Hub Lockdown (B3)**
7. **Automated Assessment-to-Ledger Bridge & Minting Pipeline**
8. **Production Environment Variables & Pre-Flight Checklist**

---

## 📑 Summary of All Changes Since Guide #7

| Area | Guide #7 Status | Final Status (Now Active) |
|---|---|---|
| **High-Risk Elevation** | Password + TOTP only on login | **B1 Step-Up MFA:** Sensitive actions (approvals, revocations, MFA resets) require a 5-minute single-use `x-step-up-token`. |
| **Self-Service Settings** | Mock UI in `SettingsScreen.tsx` | **B2 Profile & Sessions:** Real endpoints for `GET /profile`, `PATCH /profile` (password change with `token_version` invalidation), and `GET /sessions`. |
| **Token Theft Protection** | Standard refresh token rotation | **B2 Token Reuse Detection:** Replay of an already-rotated token triggers instant revocation of the entire session family. |
| **Hub Enrolment Capacity** | Unchecked in frontend | **FR-CAND-01 Quota:** Backend enforces 60-candidate limit via advisory locks; returns HTTP `409 Conflict`. |
| **Hardware & Laptop Security** | Device fingerprint recorded only | **B3 Device Authorization & Lockdown:** Hardware credential verification, live device health monitoring, and one-click emergency Hub Lockdown. |
| **Blockchain Minting Bridge** | Relayer polled empty queue | **Automated Handshake:** `assessment.approved` automatically creates VC credentials and enqueues them for Polygon Amoy minting. |

---

## 1. Feature B1 — Step-Up MFA Authorization (`POST /api/auth/step-up`)

Privileged actions require elevating session privileges via a fresh MFA verification challenge before execution.

### 1.1 The Elevation Lifecycle

```
┌────────────────────────────────────────────────────────────────────────┐
│                   1. User Attempts Sensitive Action                    │
│      (e.g., ApprovalsScreen -> Click "Approve & Issue to Ledger")      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Frontend prompts user for a fresh 6-digit TOTP code                 │
│    (or 8-character backup code) via Challenge Modal.                   │
│    Calls POST /api/auth/step-up                                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Backend verifies code and issues single-use RS256 stepUpToken:      │
│    200 OK: {                                                           │
│      "success": true,                                                  │
│      "stepUpToken": "<RS256 JWT, 5-min expiry, specific scope>",       │
│      "scope": "APPROVE_ASSESSMENT",                                    │
│      "expiresIn": 300                                                  │
│    }                                                                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Frontend Retries Sensitive Action with Header:                      │
│    POST /api/assessments/:id/approve                                   │
│    Headers: {                                                          │
│      "Authorization": "Bearer <accessToken>",                          │
│      "x-step-up-token": "<stepUpToken>"                                │
│    }                                                                   │
│    Backend validates scope & marks token JTI as used in DB.            │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Requesting a Step-Up Token (`POST /api/auth/step-up`)

* **Auth:** Requires active user session (`Bearer <accessToken>`).
* **Headers:** `Authorization: Bearer <accessToken>`
* **Body:** Must provide `scope` and **either** `mfaCode` or `backupCode`.

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
  * `'APPROVE_ASSESSMENT'` — For Superintendent assessment approval.
  * `'REVOKE_CREDENTIAL'` — For credential revocations.
  * `'REGISTER_HUB_KEY'` — For cryptographic hub key registration.
  * `'CHANGE_ROLE'` — For staff role modifications.
  * `'RESET_MFA'` — For administrative MFA resets.

* **Success Response (`200 OK`):**
```json
{
  "success": true,
  "message": "Step-up authentication successful",
  "stepUpToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "scope": "APPROVE_ASSESSMENT",
  "expiresIn": 300
}
```

* **Error Handling:**
  * `400 Bad Request`: `{ "success": false, "message": "Provide exactly one MFA code or backup code" }`
  * `401 Unauthorized`: `{ "success": false, "message": "Invalid MFA code" }`
  * `403 Forbidden`: `{ "success": false, "message": "Token scope does not authorize this action" }`
  * `423 Locked`: `{ "success": false, "message": "Account temporarily locked due to too many failed MFA attempts. Try again in 15 minutes." }` (triggers on 5 consecutive failures).

---

## 2. Feature B2 — Profile & Self-Service Password Management

Enables self-service credential management in `SettingsScreen.tsx`.

### 2.1 Fetch Current User Profile (`GET /api/auth/profile`)

* **Auth:** `Bearer <accessToken>`
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
    "last_login": "2026-11-03T08:30:00.000Z",
    "created_at": "2026-01-15T10:00:00.000Z"
  }
}
```

### 2.2 Change Password (`PATCH /api/auth/profile`)

* **Auth:** `Bearer <accessToken>`
* **Body:** Must provide exactly `currentPassword` and `newPassword`.
```json
{
  "currentPassword": "OldPassword123!",
  "newPassword": "NewStrongPassword456!"
}
```
* **Password Policy:** Minimum 8 characters; must differ from current password.
* **Security Side-Effect:** Updating the password increments `token_version` in PostgreSQL, immediately terminating all existing sessions across other devices.

---

## 3. Feature B2 — Active Sessions & Token Reuse Protection

### 3.1 List Active Sessions (`GET /api/auth/sessions`)

* **Auth:** `Bearer <accessToken>`
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
      "created_at": "2026-11-03T08:00:00.000Z",
      "last_active": "2026-11-03T09:15:00.000Z",
      "expires_at": "2026-11-10T08:00:00.000Z",
      "is_current": true
    },
    {
      "session_id": "f9e8d7c6-b5a4-3210-fedc-ba9876543210",
      "device_fingerprint": "dfp_5f6e7d8c9b0a",
      "ip_address": "42.201.64.88",
      "created_at": "2026-10-30T14:22:00.000Z",
      "last_active": "2026-11-02T18:40:00.000Z",
      "expires_at": "2026-11-09T14:22:00.000Z",
      "is_current": false
    }
  ]
}
```

### 3.2 Refresh Token Reuse Detection & Interceptor Protocol

If an attacker captures and replays an already-rotated refresh token:
1. The backend detects the reuse attempt, marks the entire session family as compromised, and invalidates all associated tokens (`AUTH_REFRESH_TOKEN_REUSE_DETECTED`).
2. Returns HTTP `401 Unauthorized`.
3. **Frontend Action in `src/services/api.ts`:**
```typescript
if (response.status === 401) {
  const errorData = await response.clone().json().catch(() => ({}));
  if (
    errorData.message?.includes("Invalid or expired refresh token") ||
    errorData.message?.includes("Session has been revoked")
  ) {
    authStore.clear();
    window.location.href = "/login?reason=session_revoked";
  }
}
```

---

## 4. FR-CAND-01 — 60-Candidate Enrolment Quota

Each testing hub has a strict maximum enrolment capacity of **60 candidates**.

### 4.1 Quota Exceeded Response (`POST /api/candidates`)

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

### 4.2 Frontend Integration in `EnrollmentScreen.tsx`
* Catch `error.statusCode === 409` or `error.status === 409`.
* Display a clear alert banner: *"Testing Hub Quota Reached: Maximum 60 candidates have already enrolled in this hub."*
* Disable the submit button and prevent duplicate retries.

---

## 5. Feature B3 — Device Authorization & Hub Lockdown

This enterprise security module ensures that Trade Testers and Center Superintendents can only log in from pre-approved testing-hub laptops.

### 5.1 Device Enforcement Modes (`DEVICE_ENFORCEMENT`)

The backend operates in one of three modes:
* `audit`: Allows unregistered devices but logs warnings.
* `warn`: Allows access with warning flags.
* `enforce`: **Strict Production Mode.** Rejects logins from unregistered laptops, mismatched fingerprints, or non-compliant EDR systems.
*(Note: `SUPER_ADMIN` accounts are exempt from device lockdown checks to ensure emergency remote access).*

### 5.2 Device Headers Contract

Testing hub clients must attach these headers on authenticated requests:
* `x-device-fingerprint`: Unique 32-character browser/hardware fingerprint.
* `x-device-credential`: 64-character hexadecimal device token assigned during hardware provisioning.

### 5.3 Super Admin Device Management Endpoints

Super Admins manage laptops via `/api/super-admin/devices/*`:

| Endpoint | Method | Payload / Params | Purpose |
|---|---|---|---|
| `/api/super-admin/devices` | `POST` | `{ hubLocationId, deviceName, deviceFingerprint, deviceCredential }` | Register an authorized hub laptop |
| `/api/super-admin/devices` | `GET` | `?hubLocationId=1` | List all authorized devices |
| `/api/super-admin/devices/health` | `GET` | — | Real-time device health & online/offline overview |
| `/api/super-admin/devices/lockdown` | `POST` | `{ hubLocationId: 1, isLocked: true }` | **Emergency Lockdown:** Freezes all logins from Hub 1 |
| `/api/super-admin/devices/:deviceId/revoke` | `POST` | — | Revokes laptop and instantly kills all active sessions |

### 5.4 Device Heartbeat (`POST /api/auth/device/heartbeat`)

Hub devices periodically report health status to keep the online monitor active:
* **Headers:** `x-device-credential`, `x-device-fingerprint`
* **Body:**
```json
{
  "edrStatus": "compliant"
}
```
* **Allowed Values for `edrStatus`:** `'compliant'`, `'non_compliant'`, `'unknown'`.
* *Note:* The heartbeat endpoint remains accessible even when a hub is in lockdown to keep monitoring active.

---

## 6. Automated Ledger Minting Handshake

The background blockchain minting bridge is now fully wired in production:

```
Superintendent clicks "Approve" (ApprovalsScreen.tsx)
                   │
                   ▼
POST /api/assessments/:id/approve
                   │
                   ▼
Backend sets assessment status = 'APPROVED'
Emits event: eventBus.emitSafely('assessment.approved', payload)
                   │
                   ▼
App Subscriber (src/app.js) catches event:
├── Calls ledgerService.issueCredentialOnly() -> creates Verifiable Credential
└── Calls ledgerService.approveAndQueueCredential() -> pushes to candidate.minting_queue
                   │
                   ▼
30-Second Background Relayer loop:
├── Reads pending queue items
├── Signs and broadcasts transaction to Polygon Amoy
├── Saves polygon_tx_hash and block_number
└── Updates assessment status from 'APPROVED' -> 'MINTED'
                   │
                   ▼
CredentialsScreen.tsx displays "MINTED" with Polygonscan link:
https://amoy.polygonscan.com/tx/0x...
```

---

## 7. Frontend Integration Code Snippet (Service Layer)

Add these methods to `src/services/api.ts` or `src/services/superAdmin.ts`:

```typescript
// ============================================================
// Step-Up MFA, Profile & Device Management API Extensions
// ============================================================

export interface DeviceHealth {
  deviceId: string;
  hubLocationId: number;
  deviceName: string;
  edrStatus: 'compliant' | 'non_compliant' | 'unknown';
  isOnline: boolean;
  lastHeartbeatAt: string | null;
  revoked: boolean;
}

export const enhancedApi = {
  // B1: Step-Up Token Request
  async requestStepUp(scope: string, mfaCode?: string, backupCode?: string): Promise<string> {
    const res = await api.post<{ success: boolean; stepUpToken: string }>('/api/auth/step-up', {
      scope,
      ...(mfaCode ? { mfaCode } : { backupCode }),
    });
    return res.data.stepUpToken;
  },

  // B2: Profile & Password
  async getProfile() {
    const res = await api.get('/api/auth/profile');
    return res.data.profile;
  },

  async updatePassword(currentPassword: string, newPassword: string) {
    const res = await api.patch('/api/auth/profile', { currentPassword, newPassword });
    return res.data;
  },

  async getSessions() {
    const res = await api.get('/api/auth/sessions');
    return res.data.sessions;
  },

  // B3: Device Management (Super Admin)
  async getDeviceHealth(): Promise<DeviceHealth[]> {
    const res = await api.get('/api/super-admin/devices/health');
    return res.data.devices;
  },

  async setHubLockdown(hubLocationId: number, isLocked: boolean) {
    const res = await api.post('/api/super-admin/devices/lockdown', { hubLocationId, isLocked });
    return res.data;
  },

  async revokeDevice(deviceId: string) {
    const res = await api.post(`/api/super-admin/devices/${deviceId}/revoke`);
    return res.data;
  },
};
```

---

## 8. Production Environment Reference Matrix

Ensure the frontend `.env.production` is configured as follows for AWS deployments:

| Variable | Target Environment | Value / Pattern |
|---|---|---|
| `VITE_API_BASE_URL` | AWS EC2 / ALB | `http://<EC2_PUBLIC_IP>:3000` or `https://api.nsp.gov.pk` |
| `VITE_RPC_URL` | Polygon Amoy Testnet | `https://polygon-amoy.infura.io/v3/<YOUR_INFURA_KEY>` |
| `VITE_VERIFIER_CONTRACT_ADDRESS` | Deployed Smart Contract | `0x<40-hex-characters>` (leave blank for backend fallback) |

---

## 9. Final Pre-Flight Integration Checklist

- [x] **FR-AUTH:** Login, TOTP MFA, 15-min lockouts, and backup code recovery verified.
- [x] **FR-CAND:** 60-candidate hub quota rejection (409) and S3 photo upload verified.
- [x] **FR-ASSE:** DRAFT, evidence upload, submission, and Superintendent approval/rejection workflows active.
- [x] **FR-LEDG:** Automated event listener queues credentials to Polygon Amoy relayer on approval.
- [x] **FR-VERI:** Public QR verification and Manual Entry verification respond in `< 2.0s`.
- [x] **FR-ADMIN:** Super Admin dashboard, staff provisioning, MFA reset QR modal, and session killing active.
- [x] **B1 Step-Up:** Sensitive actions challenge for TOTP and attach `x-step-up-token`.
- [x] **B2 Profile:** Self-service password updates and active sessions list functional.
- [x] **B3 Devices:** Device authorization, heartbeat reporting, and emergency hub lockdown active.
