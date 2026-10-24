# NSP — Frontend Integration Guide #7

**Audience:** Frontend teams (Super Admin Portal, Issuer Portal, Superintendent Dashboard)  
**Supersedes:** Guide #6 — read this as a **delta**. Everything in Guide 4 (Auth lifecycle, rotating token refresh, backup codes, account lockout), Guide 5 (Ledger issuance, approval, and on-chain verification), and Guide 6 (Device fingerprinting, assessment-to-ledger bridge, architecture mandates) remains active and valid.  
**What's new since Guide 6:**
1. **Super Admin Management Engine is LIVE (`/api/super-admin/*`):** The administrative dashboard, user provisioning, session management, and platform audit explorer are fully deployed and secured with RS256 JWT role guards (`SUPER_ADMIN`).
2. **Staff Provisioning & Dynamic MFA Onboarding:** Super Admins can provision new Trade Testers and Center Superintendents (`POST /api/super-admin/users`) with automatic server-side encrypted MFA generation and instant QR setup URI (`otpauthUrl`) delivery.
3. **MFA Enrollment & Self-Service Flow (`/api/auth/mfa/enroll/*`):** Dedicated, secure MFA enrollment lifecycle utilizing short-lived enrollment tokens (`authenticateMfaEnrollment`), handling first-time logins and administrator-initiated resets.
4. **Administrative Account Lockout & Instant Revocation:** Super Admins can freeze/unfreeze accounts (`POST /api/super-admin/users/:userId/lock`). Account locking immediately bumps `token_version` to invalidate all active JWTs in real time without waiting for token expiration.
5. **MFA Reset & Emergency Recovery:** Super Admins can reset compromised or lost authenticators (`POST /api/super-admin/users/:userId/reset-mfa`), rotating secrets server-side and placing the user in pending enrollment.
6. **Active Session Explorer & Targeted Force-Kill:** Real-time visibility into all active platform sessions across hubs, IPs, and device fingerprints, with instant remote session revocation (`POST /api/super-admin/sessions/:sessionId/revoke`).
7. **Platform Dashboard & System Audit Explorer:** High-level metrics (`/dashboard`) and full security event audit trail inspection (`/audit-logs`).

---

## ⚠️ Summary of Changes Since Guide 6

| Guide 6 said | Now true in Guide 7 |
| --- | --- |
| "Super Admin screens: Partial Live (credentials review only)" | **100% Live.** Complete Super Admin control plane is mounted at `/api/super-admin` (users, sessions, locks, audit logs, dashboard metrics). See §2 – §7. |
| "MFA Setup: Manual seed script required" | **Automated.** Native MFA enrollment flow (`/api/auth/mfa/enroll/start` and `/confirm`) using QR code setup URIs is active. See §1. |
| "Session invalidation requires token expiration" | **Instant.** Database-backed `token_version` claim ensures locked users or revoked sessions fail immediately on their next API call. See §1.4. |
| Screens IP-11 – IP-13 (Admin user management) on hold | **Unblocked.** Frontend can now construct the entire Super Admin web app. |

---

## 1. MFA Enrollment & Self-Service Lifecycle

When a new user is created by a Super Admin, or when an existing user's MFA is reset, their account is flagged with `mfa_enrollment_pending = true` and `is_mfa_active = false`.

### 1.1 First-Time Login / Reset State Machine

```
┌────────────────────────────────────────────────────────────────────────┐
│                        1. User Submits Login                           │
│                     POST /api/auth/login                               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Backend verifies email + password:                                     │
│ Checks if mfa_enrollment_pending === true                              │
│ Returns 200 OK with:                                                   │
│ {                                                                      │
│   "enrollmentRequired": true,                                          │
│   "enrollmentToken": "<short-lived RS256 JWT, 5-min expiry>",          │
│   "message": "Password verified. MFA enrollment is required."          │
│ }                                                                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Frontend redirects user to Enrollment Screen (with enrollmentToken) │
│ Calls POST /api/auth/mfa/enroll/start                                  │
│ Backend returns { secret, otpauthUrl }                                 │
│ Frontend renders QR Code via `qrcode.react`                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. User scans QR in Google Authenticator / Authy                       │
│ Enters 6-digit code into frontend                                      │
│ Calls POST /api/auth/mfa/enroll/confirm with { mfaCode: "123456" }     │
│ Backend verifies code, sets is_mfa_active = true,                      │
│ mfa_enrollment_pending = false                                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Enrollment complete! User is redirected to login to establish       │
│ normal authenticated session + refresh tokens.                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 Start MFA Enrollment (`POST /api/auth/mfa/enroll/start`)

Generates a fresh TOTP secret on the server, encrypts it with AES-256-GCM in the database, and returns the plaintext secret and standard `otpauth://` setup URI.

* **Authentication:** Requires `Bearer <enrollmentToken>` in `Authorization` header.
* **Request:** No body required.

```http
POST /api/auth/mfa/enroll/start
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json
```

* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "message": "Scan the authenticator setup URI and verify a code to finish enrollment.",
  "secret": "JBSWY3DPEHPK3PXP",
  "otpauthUrl": "otpauth://totp/NSP:tester@hub01.nsp.gov.pk?secret=JBSWY3DPEHPK3PXP&issuer=NSP"
}
```

* **Error Responses:**
  * `401 Unauthorized`: Missing or invalid `enrollmentToken`, or token expired (5 minutes limit).
  * `409 Conflict`: User account unavailable or locked.

---

### 1.3 Confirm MFA Enrollment (`POST /api/auth/mfa/enroll/confirm`)

Verifies the user's first 6-digit authenticator code against the newly stored secret. On success, permanently activates MFA for the account.

* **Authentication:** Requires `Bearer <enrollmentToken>` in `Authorization` header.
* **Request Body:**

```json
{
  "mfaCode": "583921"
}
```

* **Validation Rules:** `mfaCode` must be a string containing exactly 6 numeric digits (`/^\d{6}$/`).
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "message": "MFA enrollment completed. Log in using your password and authenticator code."
}
```

* **Error Responses:**
  * `400 Bad Request`: `{ "success": false, "message": "Invalid MFA code" }` or malformed code format.
  * `401 Unauthorized`: Invalid or expired enrollment token.

---

### 1.4 Real-Time Token Invalidation (`token_version`)

Every user record now contains a `token_version` integer in PostgreSQL.
* Every access token contains:
  ```json
  {
    "sub": "user-uuid",
    "email": "user@nsp.gov.pk",
    "role": "TRADE_TESTER",
    "hubLocationId": 1,
    "tokenVersion": 0
  }
  ```
* When an administrator locks a user or resets their credentials, the backend increments `token_version = token_version + 1`.
* **Frontend Handling:** Any subsequent API call using an outdated token immediately returns `401 Unauthorized` with:
  ```json
  {
    "success": false,
    "message": "Session is no longer valid. Please authenticate again."
  }
  ```
* When your Axios/Fetch response interceptor catches this message, immediately clear local authentication state and redirect the user to `/login`.

---

## 2. Super Admin Dashboard (`GET /api/super-admin/dashboard`)

Provides high-level system metrics and health overview across all testing hubs nationwide.

* **Access:** `SUPER_ADMIN` only.
* **Endpoint:** `GET /api/super-admin/dashboard`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "stats": {
      "users": {
        "total": 42,
        "superAdmins": 2,
        "centerSuperintendents": 15,
        "tradeTesters": 25,
        "activeMfa": 38,
        "pendingMfa": 4,
        "adminLocked": 1
      },
      "sessions": {
        "activeCount": 18
      },
      "candidates": {
        "totalEnrolled": 1250,
        "verifiedCnic": 1250
      },
      "assessments": {
        "totalAssessed": 980,
        "submitted": 45,
        "approved": 20,
        "rejected": 5
      },
      "ledger": {
        "totalCredentials": 910,
        "pendingApproval": 20,
        "approved": 15,
        "mintedOnChain": 875,
        "queuePending": 15,
        "queueFailed": 0
      }
    },
    "message": "Dashboard statistics retrieved successfully"
  }
}
```

---

## 3. Staff & User Administration (`/api/super-admin/users`)

Allows Super Admins to list, inspect, provision, lock, and unlock testing hub staff.

### 3.1 List Users (`GET /api/super-admin/users`)

* **Query Parameters:**
  * `role`: Optional filter (`TRADE_TESTER`, `CENTER_SUPERINTENDENT`, or `SUPER_ADMIN`).
  * `search`: Case-insensitive search on email address.
  * `limit`: Items per page (default: `50`, max: `100`).
  * `offset`: Pagination offset (default: `0`).

```http
GET /api/super-admin/users?role=TRADE_TESTER&limit=20&offset=0
Authorization: Bearer <SUPER_ADMIN_ACCESS_TOKEN>
```

* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "users": [
      {
        "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "email": "tester.lahore@nsp.gov.pk",
        "role": "TRADE_TESTER",
        "hubLocationId": 1,
        "isMfaActive": true,
        "mfaEnrollmentPending": false,
        "adminLocked": false,
        "failedLoginAttempts": 0,
        "lockedUntil": null,
        "createdAt": "2026-10-15T08:30:00.000Z"
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1
    }
  }
}
```

---

### 3.2 Get User Details (`GET /api/super-admin/users/:userId`)

Returns deep security metadata for a specific user, including recent audit activities and active sessions.

* **Endpoint:** `GET /api/super-admin/users/:userId`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "user": {
      "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "email": "tester.lahore@nsp.gov.pk",
      "role": "TRADE_TESTER",
      "hubLocationId": 1,
      "isMfaActive": true,
      "mfaEnrollmentPending": false,
      "adminLocked": false,
      "tokenVersion": 1,
      "failedLoginAttempts": 0,
      "lockedUntil": null,
      "createdAt": "2026-10-15T08:30:00.000Z"
    },
    "sessions": [
      {
        "sessionId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "ipAddress": "192.168.1.50",
        "deviceFingerprint": "9f83c21a4e...",
        "createdAt": "2026-10-24T09:00:00.000Z",
        "expiresAt": "2026-10-31T09:00:00.000Z"
      }
    ],
    "recentAuditEvents": [
      {
        "logId": 1042,
        "eventType": "AUTH_LOGIN_SUCCESS",
        "ipAddress": "192.168.1.50",
        "createdAt": "2026-10-24T09:00:00.000Z",
        "details": { "method": "TOTP" }
      }
    ]
  }
}
```

---

### 3.3 Create Hub User (`POST /api/super-admin/users`)

Provisions a new Trade Tester or Center Superintendent.
* The backend automatically generates an encrypted MFA secret.
* It returns initial authenticator provisioning material (`mfaEnrollment.secret` and `mfaEnrollment.otpauthUrl`) in the response.
* **UI Recommendation:** The Super Admin screen should display a printable or scannable QR code dialog immediately upon submission so the admin can onboard the staff member.

* **Request Body:**

```json
{
  "email": "superintendent.karachi@nsp.gov.pk",
  "password": "TemporarySecurePassword#2026",
  "role": "CENTER_SUPERINTENDENT",
  "hubLocationId": 2
}
```

* **Validation Rules:**
  * `email`: Valid email format, maximum 254 characters.
  * `password`: Plaintext string, minimum 12 characters, maximum 72 characters.
  * `role`: Must be either `TRADE_TESTER` or `CENTER_SUPERINTENDENT` (`SUPER_ADMIN` accounts cannot be created via API).
  * `hubLocationId`: Positive integer referencing a valid testing hub.

* **Success Response (`201 Created`):**

```json
{
  "success": true,
  "message": "User created successfully. MFA enrollment is required.",
  "data": {
    "userId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "email": "superintendent.karachi@nsp.gov.pk",
    "role": "CENTER_SUPERINTENDENT",
    "hubLocationId": 2,
    "isMfaActive": false,
    "mfaEnrollmentPending": true,
    "adminLocked": false,
    "createdAt": "2026-10-25T00:15:00.000Z"
  },
  "mfaEnrollment": {
    "secret": "NZQW2Z3TPEHPK3PXP4",
    "otpauthUrl": "otpauth://totp/NSP:superintendent.karachi@nsp.gov.pk?secret=NZQW2Z3TPEHPK3PXP4&issuer=NSP"
  }
}
```

* **Error Responses:**
  * `400 Bad Request`: Missing fields, invalid role, or invalid hub location ID.
  * `409 Conflict`: User with this email already exists (`{ "success": false, "message": "An account with this email already exists" }`).

---

### 3.4 Lock & Unlock User (`POST /api/super-admin/users/:userId/lock` & `/unlock`)

Used to freeze staff accounts immediately during security incidents or staff offboarding.

* **Lock Endpoint:** `POST /api/super-admin/users/:userId/lock`
* **Unlock Endpoint:** `POST /api/super-admin/users/:userId/unlock`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "message": "User account locked successfully",
    "user": {
      "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "email": "tester.lahore@nsp.gov.pk",
      "role": "TRADE_TESTER",
      "adminLocked": true,
      "tokenVersion": 2
    }
  }
}
```

> **Security Note:** Locking a user revokes all their existing sessions in `auth.sessions` and increments `token_version`. Even if the user has an unexpired access token, their next API call will be rejected.

---

### 3.5 Reset User MFA (`POST /api/super-admin/users/:userId/reset-mfa`)

Use when a staff member loses their authenticator device or replaces their phone.

* **Endpoint:** `POST /api/super-admin/users/:userId/reset-mfa`
* **Request:** No body required.
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "message": "MFA reset successfully. User must enroll a new authenticator.",
    "user": {
      "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "email": "tester.lahore@nsp.gov.pk",
      "isMfaActive": false,
      "mfaEnrollmentPending": true,
      "tokenVersion": 3
    }
  },
  "mfaEnrollment": {
    "secret": "ORXWGYLTMVZXILJRMFSW2",
    "otpauthUrl": "otpauth://totp/NSP:tester.lahore@nsp.gov.pk?secret=ORXWGYLTMVZXILJRMFSW2&issuer=NSP"
  }
}
```

---

## 4. Active Sessions & Remote Revocation (`/api/super-admin/sessions`)

Super Admins can monitor active sessions across all hubs and remotely terminate any session.

### 4.1 List Active Sessions (`GET /api/super-admin/sessions`)

* **Query Parameters:** `limit` (default: `100`, max: `100`).
* **Endpoint:** `GET /api/super-admin/sessions?limit=50`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": [
    {
      "sessionId": "e2a1b4c3-d5e6-4f7a-8b9c-0d1e2f3a4b5c",
      "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "email": "tester.lahore@nsp.gov.pk",
      "role": "TRADE_TESTER",
      "hubLocationId": 1,
      "ipAddress": "182.180.75.12",
      "deviceFingerprint": "4a7b9c1d2e3f...",
      "createdAt": "2026-10-24T10:15:00.000Z",
      "expiresAt": "2026-10-31T10:15:00.000Z"
    }
  ]
}
```

---

### 4.2 Force-Revoke a Session (`POST /api/super-admin/sessions/:sessionId/revoke`)

Immediately invalidates a specific session ID. The user's refresh token will no longer rotate, and their current access token will be rejected by middleware.

* **Endpoint:** `POST /api/super-admin/sessions/:sessionId/revoke`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": {
    "message": "Session revoked successfully"
  }
}
```

* **Error Responses:**
  * `400 Bad Request`: Invalid UUID format for `sessionId`.
  * `404 Not Found`: Session not found or already revoked.

---

## 5. Security Audit Trail Explorer (`GET /api/super-admin/audit-logs`)

Provides complete observability into platform events for compliance and security auditing.

* **Query Parameters:** `limit` (default: `50`, max: `100`).
* **Endpoint:** `GET /api/super-admin/audit-logs?limit=50`
* **Success Response (`200 OK`):**

```json
{
  "success": true,
  "data": [
    {
      "logId": 8520,
      "eventType": "SUPER_ADMIN_USER_LOCKED",
      "userId": "00000000-0000-0000-0000-000000000001",
      "email": "superadmin@nsp.gov.pk",
      "ipAddress": "192.168.1.100",
      "createdAt": "2026-10-25T00:20:00.000Z",
      "details": {
        "targetUserId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "targetEmail": "tester.lahore@nsp.gov.pk",
        "targetRole": "TRADE_TESTER"
      }
    },
    {
      "logId": 8519,
      "eventType": "AUTH_DEVICE_MISMATCH",
      "userId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "email": "tester.lahore@nsp.gov.pk",
      "ipAddress": "182.180.75.14",
      "createdAt": "2026-10-25T00:18:22.000Z",
      "details": {
        "mode": "PHASE_1_AUDIT_ONLY",
        "action": "ALLOWED",
        "incomingFingerprint": "7c8d9e0f...",
        "storedFingerprint": "4a7b9c1d..."
      }
    }
  ]
}
```

### Complete List of Audit Event Types

| Event Type | Trigger |
| :--- | :--- |
| `AUTH_LOGIN_SUCCESS` | Successful password + MFA / Backup code verification |
| `AUTH_LOGIN_FAILED` | Bad password or non-existent email |
| `AUTH_LOGIN_BLOCKED` | Account is admin-locked or temporarily locked (5 failed attempts) |
| `AUTH_DEVICE_MISMATCH` | Refresh token presented from a different device fingerprint (Phase 1 alert) |
| `AUTH_MFA_ENROLLMENT_STARTED` | User or admin initiated MFA key generation |
| `AUTH_MFA_ENROLLMENT_COMPLETED` | User confirmed first 6-digit TOTP code |
| `AUTH_TOKEN_REFRESHED` | Successful rotating token exchange |
| `SUPER_ADMIN_USER_CREATED` | New staff user provisioned |
| `SUPER_ADMIN_USER_LOCKED` | Administrator manually froze account |
| `SUPER_ADMIN_USER_UNLOCKED` | Administrator manually unfroze account |
| `SUPER_ADMIN_MFA_RESET` | Administrator regenerated TOTP secret |
| `SUPER_ADMIN_SESSION_REVOKED` | Administrator force-terminated an active session |

---

## 6. Frontend TypeScript SDK / Service Implementation

Here is a ready-to-use TypeScript service for the Super Admin frontend portal (`src/services/superAdmin.service.ts`):

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3000/api',
});

// Attach Super Admin JWT and Device Fingerprint
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('nsp_access_token');
  const fingerprint = localStorage.getItem('nsp_device_fingerprint');

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (fingerprint) {
    config.headers['x-device-fingerprint'] = fingerprint;
  }
  return config;
});

export interface UserStats {
  total: number;
  superAdmins: number;
  centerSuperintendents: number;
  tradeTesters: number;
  activeMfa: number;
  pendingMfa: number;
  adminLocked: number;
}

export interface DashboardStats {
  users: UserStats;
  sessions: { activeCount: number };
  candidates: { totalEnrolled: number; verifiedCnic: number };
  assessments: { totalAssessed: number; submitted: number; approved: number; rejected: number };
  ledger: { totalCredentials: number; pendingApproval: number; approved: number; mintedOnChain: number };
}

export interface HubUser {
  userId: string;
  email: string;
  role: 'TRADE_TESTER' | 'CENTER_SUPERINTENDENT' | 'SUPER_ADMIN';
  hubLocationId: number;
  isMfaActive: boolean;
  mfaEnrollmentPending: boolean;
  adminLocked: boolean;
  failedLoginAttempts: number;
  createdAt: string;
}

export const superAdminApi = {
  // 1. Dashboard
  getDashboard: async (): Promise<DashboardStats> => {
    const res = await api.get('/super-admin/dashboard');
    return res.data.data.stats;
  },

  // 2. Users Management
  getUsers: async (params?: { role?: string; search?: string; limit?: number; offset?: number }) => {
    const res = await api.get('/super-admin/users', { params });
    return res.data.data;
  },

  getUserDetails: async (userId: string) => {
    const res = await api.get(`/super-admin/users/${userId}`);
    return res.data.data;
  },

  createUser: async (payload: { email: string; password: string; role: string; hubLocationId: number }) => {
    const res = await api.post('/super-admin/users', payload);
    return res.data;
  },

  lockUser: async (userId: string) => {
    const res = await api.post(`/super-admin/users/${userId}/lock`);
    return res.data;
  },

  unlockUser: async (userId: string) => {
    const res = await api.post(`/super-admin/users/${userId}/unlock`);
    return res.data;
  },

  resetUserMfa: async (userId: string) => {
    const res = await api.post(`/super-admin/users/${userId}/reset-mfa`);
    return res.data;
  },

  // 3. Sessions
  getSessions: async (limit = 50) => {
    const res = await api.get('/super-admin/sessions', { params: { limit } });
    return res.data.data;
  },

  revokeSession: async (sessionId: string) => {
    const res = await api.post(`/super-admin/sessions/${sessionId}/revoke`);
    return res.data;
  },

  // 4. Audit Trail
  getAuditLogs: async (limit = 50) => {
    const res = await api.get('/super-admin/audit-logs', { params: { limit } });
    return res.data.data;
  }
};
```

---

## 7. UI Wireframes & Workflow Guides

### 7.1 New Staff Onboarding Modal (`POST /api/super-admin/users`)

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Create New Hub Staff Member                          │
├────────────────────────────────────────────────────────────────────────┤
│ Email:          [ tester.peshawar@nsp.gov.pk                        ]  │
│ Initial Pass:   [ ••••••••••••••••••••••                            ]  │
│ Role:           ( ) Center Superintendent     (•) Trade Tester         │
│ Hub Location:   [ Hub #3 — Peshawar Vocational Training Center     ▼]  │
│                                                                        │
│                [ Cancel ]          [ Create & Generate MFA ]           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ On 201 Created Success
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Authenticator Enrollment QR Code                       │
├────────────────────────────────────────────────────────────────────────┤
│ Scan this QR code with the staff member's Google Authenticator app:    │
│                                                                        │
│                       █████████████████                                │
│                       ██  █████  ███ ██                                │
│                       ██  █████  ██  ██                                │
│                       █████████████████                                │
│                                                                        │
│ Secret Key: JBSWY3DPEHPK3PXP                                           │
│ URI: otpauth://totp/NSP:tester.peshawar@nsp.gov.pk?secret=...          │
│                                                                        │
│ ℹ️ The user will also be prompted to verify this key upon first login. │
│                                                                        │
│                          [ Done / Close ]                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Summary Checklist for Frontend Teams

- [ ] **MFA Enrollment UI:** Implement enrollment screen handling `enrollmentRequired: true` from `/login` using `qrcode.react`.
- [ ] **User Administration:** Wire up the staff list, filter by role/hub, and integrate the user creation modal with QR preview.
- [ ] **Lock/Unlock Actions:** Add instant lock/unlock confirmation modals with status badges (`adminLocked ? 'LOCKED' : 'ACTIVE'`).
- [ ] **MFA Reset:** Add "Reset MFA" button to staff details screen displaying the newly generated QR setup URI.
- [ ] **Active Sessions Table:** Display active sessions with device fingerprint hashes, IP addresses, and "Revoke Session" actions.
- [ ] **Audit Trail Explorer:** Render security event table with filterable event types.
- [ ] **Session Invalidation Interceptor:** Verify that an Axios/Fetch 401 response with `"Session is no longer valid"` immediately clears local storage and routes to the login page.
