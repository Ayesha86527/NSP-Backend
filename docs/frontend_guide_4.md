# NSP — Frontend Integration Guide #4

**Audience:** Frontend team (Issuer Portal — Auth, Trade Tester, and Superintendent screens)  
**Supersedes:** Guide #3 — read this as a **delta**. Anything in Guide 3 not mentioned here still applies.  
**What's new since Guide 3:** The entire **Auth Session & Recovery lifecycle is now LIVE**. Token refresh with rotation is live (auto-refresh on 401), session revocation / logout is live, backup code generation, status check, and fallback login (Screen IP-03) are live, and **Account Lockout protection (5 failed attempts = 15m lock)** is now active.  
**Still not ready:** Ledger / on-chain minting confirmation (`MINTED` status will appear once the ledger queue ships), public verification API (Verifier DApp), Super Admin management screens.

---

## ⚠️ Outdated sections in Guide 3

| Guide 3 said | Now true in Guide 4 |
| --- | --- |
| "Token refresh / revoke / backup codes: routes exist but return 500 — do not build against them" | **Live & fully functional.** See §1, §2, and §3. |
| "Auto-refresh on 401: ⛔ Still wait" | **Ready to build.** Standard refresh token interceptor pattern with rotation. See §1. |
| "Backup-code recovery UI (IP-03): ⛔ Still wait" | **Ready to build.** Full backup code lifecycle (generate, view status, login fallback). See §3. |
| `POST /api/auth/verify-mfa` response example only showed `accessToken` | **Now includes `refreshToken`.** Update your auth store to capture and store both tokens. |

---

## 1. Token Refresh & Rotation Flow (`FR-AUTH-02`)

The backend now issues **rotating refresh tokens** with a 7-day lifetime alongside 15-minute RS256 access tokens.

### 1.1 `POST /api/auth/refresh` → `200`

Refreshes an expired access token using the stored refresh token.

**Request body:**
```json
{
  "refreshToken": "<hex-string-from-login-or-last-refresh>"
}
```

**Success response (`200`):**
```json
{
  "success": true,
  "message": "Access token refreshed successfully",
  "accessToken": "<new-RS256-JWT>",
  "refreshToken": "<new-rotated-refresh-token>",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

### 1.2 Critical Rotation Contract (Security Rule)
* **Single-use only:** Every call to `/api/auth/refresh` **invalidates the old refresh token** and returns a brand-new `refreshToken`.
* **Immediate client update:** You **MUST** overwrite your stored `refreshToken` with the new one returned in the response. Re-using an old refresh token will fail with `401`.
* **Errors:**
  * `400`: Missing `refreshToken` in request body.
  * `401`: Token expired, already used, or revoked. When this occurs, clear local tokens and redirect to login (`IP-01`).

### 1.3 Recommended Frontend Interceptor Recipe (Axios / Fetch)
Implement a 401 interceptor that prevents multiple parallel refresh requests:

```ts
import axios from 'axios';

let isRefreshing = false;
let failedQueue: Array<{ resolve: (token: string) => void; reject: (err: any) => void }> = [];

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token!);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Handle token expiry (401), avoid looping on auth endpoints
    if (error.response?.status === 401 && !originalRequest._retry && !originalRequest.url?.includes('/api/auth/')) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const currentRefreshToken = authStore.getRefreshToken();
      if (!currentRefreshToken) {
        authStore.logout();
        return Promise.reject(error);
      }

      try {
        const { data } = await axios.post('/api/auth/refresh', {
          refreshToken: currentRefreshToken
        });

        // Store new access AND rotated refresh token
        authStore.setTokens(data.accessToken, data.refreshToken);
        originalRequest.headers['Authorization'] = `Bearer ${data.accessToken}`;

        processQueue(null, data.accessToken);
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        authStore.logout(); // Boot to IP-01
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
```

---

## 2. Server-Side Session Revocation / Logout (`POST /api/auth/revoke`)

Do not just delete tokens in the browser. Call `/api/auth/revoke` to invalidate the active session and ensure an immutable audit log is recorded on the backend.

**Endpoint:** `POST /api/auth/revoke`  
**Headers:** `Authorization: Bearer <accessToken>`  
**Request body:**
```json
{
  "refreshToken": "<active-refresh-token>"
}
```

**Success response (`200`):**
```json
{
  "success": true,
  "message": "Session revoked successfully. Token invalidated."
}
```

**Frontend flow:**  
When the user clicks "Logout", call `/api/auth/revoke` (even if it fails, proceed to clear client storage and redirect to login).

---

## 3. Backup Codes Workflow (Screen IP-03 — MFA Fallback)

Backup codes provide emergency access when a Trade Tester or Superintendent loses access to their TOTP authenticator device (`FR-AUTH-08`).

```
                    ┌────────────────────────────┐
                    │    IP-01 (Login Screen)    │
                    └──────────────┬─────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   [Has Authenticator App]                   [Lost / No Authenticator]
┌────────────────────────────┐              ┌────────────────────────────┐
│      IP-02 (Enter MFA)     │              │    IP-03 (Backup Code)     │
│   POST /api/auth/verify-mfa│              │POST /auth/verify-backup-code│
└─────────────┬──────────────┘              └─────────────┬──────────────┘
              │                                           │
              └────────────────────┬──────────────────────┘
                                   ▼
                      [Authenticated Session]
```

### 3.1 Initial Generation — `POST /api/auth/backup-codes/generate`
* **When to call:** In account security / profile settings, or during initial MFA onboarding.
* **Headers:** `Authorization: Bearer <accessToken>`
* **Body:** None.
* **Rule:** Can **only be generated once** if no codes exist. Calling it when codes already exist returns `409 Conflict`.

**Success response (`200`):**
```json
{
  "success": true,
  "message": "Backup codes generated. Save them now; they will not be shown again.",
  "backupCodes": [
    "a1b2c3d4e5f67890",
    "f9e8d7c6b5a43210",
    "1234567890abcdef",
    "abcdef1234567890",
    "b2c3d4e5f6a17890",
    "c3d4e5f6a1b27890",
    "d4e5f6a1b2c37890",
    "e5f6a1b2c3d47890",
    "f6a1b2c3d4e57890",
    "0987654321fedcba"
  ]
}
```
**UI Requirement:** Render these 10 codes in a modal with:
1. Prominent warning: *"These codes will never be displayed again. Save them in a secure location."*
2. **"Copy All"** button and/or **"Download as .txt"** button.
3. Checkbox: *"I have safely saved these 10 recovery codes"* before allowing the user to close the modal.

### 3.2 Check Status — `GET /api/auth/backup-codes/status`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Success response (`200`):**
```json
{
  "success": true,
  "totalCodes": 10,
  "unusedCodes": 8,
  "usedCodes": 2
}
```
**UI Mapping:** In the profile/security page, display: *"8 of 10 backup codes remaining"*.

### 3.3 Emergency Login via Backup Code (Screen IP-03)
* **Endpoint:** `POST /api/auth/verify-backup-code` (Public / unauthenticated)
* **When to call:** On the MFA prompt (IP-02), provide a link: *"Lost your authenticator device? Use a backup code"*, which navigates to screen **IP-03**.

**Request body:**
```json
{
  "email": "tradetester@nsp.com",
  "password": "Password123!",
  "backupCode": "a1b2c3d4e5f67890"
}
```

**Success response (`200`):**
```json
{
  "success": true,
  "message": "Backup code verified. Login successful.",
  "accessToken": "<RS256-JWT>",
  "refreshToken": "<hex-string>",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "user": {
    "id": "<uuid>",
    "email": "tradetester@nsp.com",
    "role": "TRADE_TESTER",
    "hubLocationId": 1
  }
}
```

**Errors:**
* `400`: Missing `email`, `password`, or `backupCode`.
* `401`: Invalid credentials, or code already consumed (`"Invalid or already-used backup code"`).
* `401`: Account locked out (see §4).

---

## 4. Account Lockout Safeguards (`FR-AUTH-06`)

The backend now enforces brute-force protection across password login (`/login`) and backup code login (`/verify-backup-code`):

1. **5 consecutive failed attempts** lock the account for **15 minutes**.
2. On the 5th failure, the response is:
   ```json
   {
     "success": false,
     "message": "Account locked for 15 minutes due to too many failed login attempts."
   }
   ```
3. While locked, any subsequent attempt returns:
   ```json
   {
     "success": false,
     "message": "Account locked. Please try again later."
   }
   ```
**UI Recommendation:**  
Inspect the error message on `401`. If it mentions "Account locked", render an alert banner with a lock icon explaining that the account is temporarily suspended for 15 minutes, rather than simply displaying "Invalid credentials".

---

## 5. End-to-End Updated Error Codes Cheat Sheet

| Endpoint | Status | Message / Condition | Frontend Action |
| --- | --- | --- | --- |
| `/api/auth/login` | `401` | `"Invalid email or password"` | Show inline error on login form. |
| `/api/auth/login` | `401` | `"Account locked for 15 minutes..."` | Show prominent temporary lockout alert. |
| `/api/auth/verify-mfa` | `401` | `"Invalid MFA code"` | Clear 6-digit input, highlight invalid code. |
| `/api/auth/refresh` | `400` | `"Refresh token is required"` | Clear session, redirect to login. |
| `/api/auth/refresh` | `401` | `"Invalid or expired refresh token"` | Silent refresh failed: purge tokens, redirect to login. |
| `/api/auth/verify-backup-code` | `401` | `"Invalid or already-used backup code"` | Prompt user to try another unused code. |
| `/api/auth/backup-codes/generate`| `409` | `"Backup codes already exist..."` | Do not overwrite existing codes; inform user. |
| Any protected route | `401` | `"Authentication required"` / `"Invalid token"` | Access token expired &rarr; trigger silent refresh (§1.3). |
| Any protected route | `403` | `"Access denied"` / Role mismatch | Redirect to user's assigned dashboard or show 403 page. |
| Any route | `429` | `"Too many requests..."` | Global rate limit (60 req/min) hit &rarr; display cooldown warning. |

---

## 6. Build-Now / Wait Table (Updated for Guide 4)

| Item | Screens | Status | What to do |
| --- | --- | --- | --- |
| Silent token auto-refresh (interceptor) | All | ✅ **BUILD NOW** | Implement 401 axios interceptor (§1) |
| Server-side logout (session revocation) | App Header | ✅ **BUILD NOW** | Wire logout button to `POST /api/auth/revoke` (§2) |
| Backup code generation & status | Settings / Profile | ✅ **BUILD NOW** | Build modal & code counter (§3.1, §3.2) |
| Backup code emergency login | IP-03 | ✅ **BUILD NOW** | Build fallback screen linking from IP-02 (§3.3) |
| Account lockout UX handling | IP-01, IP-03 | ✅ **BUILD NOW** | Catch lockout messages and display cooldown UI (§4) |
| Superintendent approval queue | IP-08 – IP-10 | ✅ Ready (Guide 3) | Continue integration |
| S3 photo & media uploads | IP-05, IP-06 | ✅ Ready (Guide 3) | Continue integration |
| Offline queue with `clientRequestId` | IP-05/06 offline | ✅ Ready (Guide 3) | Continue integration |
| Trade Tester assessment workflow | IP-04 – IP-07 | ✅ Ready (Guide 2) | Continue integration |
| Minting status & blockchain receipts | — | ⏳ **In Progress** | Backend ledger module is under construction; keep `status` as an open enum |
| Public verification API (Verifier DApp) | VD-01 – VD-04 | ⏳ **In Progress** | Next delivery |
| Super Admin monitoring dashboard | IP-11 – IP-13 | ⏳ **Planned** | Final release |

---

## 7. Next Milestones (Plan Ahead)

1. **Ledger & Minting Lifecycle:**  
   Once the blockchain queue worker completes, assessments in `APPROVED` status will automatically transition to `MINTED`. Your assessment detail views will receive new fields: `polygon_tx_hash`, `contract_address`, `block_number`, and `credential_id`.
2. **Public Verification API:**  
   `GET /api/verify/:credentialId` will unlock the public Verifier DApp (QR code scanner & direct credential lookup).

---

*Guide #4 generated against the merged backend as of commit `375fda3` ("feat(auth): add event bus and authentication audit trails"). All API payloads and contracts verified against active code.*
