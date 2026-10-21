# NSP — Frontend Integration & Migration Guide #6

**Audience:** Frontend engineering team (`NSP-Webapp` — Issuer Portal & Verifier DApp)  
**Status:** **Comprehensive Handover & Codebase Alignment Guide**  
**Context:** An audit of `NSP-Webapp` revealed that the frontend implementation is currently frozen at **Guide #3** (with hardcoded mock data for credentials and placeholder stubs for backup codes). Guide #6 provides the complete delta, architectural clarifications, and copy-pasteable TypeScript recipes required to bring the frontend to 100% synchronization with the active backend.

---

## 0. Key Architectural Decisions & Clarifications

Before implementing the code changes below, note the following confirmed architectural baselines:

1. **NADRA API (Supervisor Confirmation):**  
   The external NADRA API **will not be integrated at this stage**. The backend candidate module already uses an isolated adapter (`nadra.service.js`) that validates format and returns `{ verified: true, provider: 'DEVELOPMENT' }`. **Frontend action:** Continue calling `POST /api/candidates` as normal; zero changes required to enrolment forms.
2. **Redis Cache:**  
   Redis is **strictly an optional optimization layer**, not a core requirement. The backend runs 100% standalone with PostgreSQL and direct Polygon RPC queries. The frontend should connect directly to the standard backend API endpoints without expecting Redis middleware.
3. **Device Fingerprinting (`FR-AUTH-04`):**  
   To fulfill laptop binding requirements without paid services, the frontend will integrate the open-source client-side library `@fingerprintjs/fingerprintjs` and pass the identifier via `x-device-fingerprint` header (see §1.4).

---

## 1. Auth & Session Lifecycle Migration (Guide #4 Integration)

The backend now enforces rotating refresh tokens (7-day lifetime), server-side session revocation, account lockout, and full emergency backup code recovery.

### 1.1 Update `src/services/authStore.ts`
The store must persist the `refreshToken` alongside the `accessToken` so that expired tokens can be refreshed automatically.

```ts
// src/services/authStore.ts (Updated State)
export interface SessionState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  role: AppRole;
  isAuthenticated: boolean;
}

// In setSession:
setSession(user: User, accessToken?: string | null, refreshToken?: string | null) {
  const token = accessToken || null;
  const refresh = refreshToken || null;
  const role = mapServerRoleToAppRole(user.role);

  currentState = {
    user,
    accessToken: token,
    refreshToken: refresh,
    role,
    isAuthenticated: true,
  };

  setApiAuthToken(token);
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user, accessToken: token, refreshToken: refresh })
    );
  } catch {}
  notify();
}
```

---

### 1.2 Update `src/services/api.ts` (Refresh & Revoke Methods)

Add the refresh and revoke methods to `api.ts`, and update the `request()` function to handle silent token refreshing on `401 Unauthorized`:

```ts
// 1. Update MfaResponse
export interface MfaResponse {
  success: boolean;
  message: string;
  accessToken?: string;
  refreshToken?: string; // Newly added
  tokenType?: string;
  expiresIn?: number;
  user?: User;
}

// 2. Add API methods to api object:
export const api = {
  // ... existing methods ...

  async refreshAccessToken(refreshToken: string): Promise<{
    success: boolean;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    return request("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  },

  async revokeSession(refreshToken: string): Promise<{ success: boolean; message: string }> {
    return request("/api/auth/revoke", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  },

  async verifyBackupCode(payload: { email: string; password: string; backupCode: string }): Promise<MfaResponse> {
    return request("/api/auth/verify-backup-code", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async generateBackupCodes(): Promise<{ success: boolean; message: string; backupCodes: string[] }> {
    return request("/api/auth/backup-codes/generate", {
      method: "POST",
    });
  },

  async getBackupCodeStatus(): Promise<{ success: boolean; totalCodes: number; unusedCodes: number; usedCodes: number }> {
    return request("/api/auth/backup-codes/status", {
      method: "GET",
    });
  },
};
```

#### Silent Token Refresh Interceptor in `request()`:
Update the `401` handler in `src/services/api.ts` so that when a 15-minute access token expires, it silently calls `/api/auth/refresh` using `authStore.getState().refreshToken`, updates the tokens, and retries the original request seamlessly.

---

### 1.3 Server-Side Logout in `src/App.tsx`
Update `handleLogout` to revoke the refresh token on the backend before clearing client storage:

```ts
// src/App.tsx
async function handleLogout() {
  const refresh = authStore.getState().refreshToken;
  if (refresh) {
    try {
      await api.revokeSession(refresh);
    } catch (err) {
      console.warn("Backend session revocation skipped:", err);
    }
  }
  authStore.clearSession();
  setScreen("login");
}
```

---

### 1.4 Device Fingerprinting Integration (`FR-AUTH-04`)
Install the community open-source package:
```bash
npm install @fingerprintjs/fingerprintjs
```
In `src/services/api.ts`, initialize the visitor identifier once and attach it as a default header on all API calls:
```ts
import FingerprintJS from '@fingerprintjs/fingerprintjs';

let cachedFingerprint: string | null = null;

export async function getDeviceFingerprint(): Promise<string> {
  if (!cachedFingerprint) {
    try {
      const fp = await FingerprintJS.load();
      const result = await fp.get();
      cachedFingerprint = result.visitorId;
    } catch {
      cachedFingerprint = "web-client-fallback";
    }
  }
  return cachedFingerprint;
}

// In request() headers:
headers["x-device-fingerprint"] = await getDeviceFingerprint();
```

---

### 1.5 Activate Backup Codes MFA Fallback in `src/screens/MFAScreen.tsx`
Remove the hardcoded error message on lines 141–145 of `MFAScreen.tsx` and wire the real verification API:

```ts
// src/screens/MFAScreen.tsx (Updated handleBackupVerify)
async function handleBackupVerify(password: string) {
  if (!backupCode.trim()) {
    setBackupError("Please enter your backup code.");
    return;
  }
  setBackupError("");
  setState("loading");

  try {
    const res = await api.verifyBackupCode({
      email,
      password,
      backupCode: backupCode.trim(),
    });

    if (res.success && res.user && res.accessToken && res.refreshToken) {
      authStore.setSession(res.user, res.accessToken, res.refreshToken);
      setState("success");
      setTimeout(onSuccess, 600);
      return;
    }
    setBackupError(res.message || "Invalid backup code.");
    setState("invalid");
  } catch (err: any) {
    setState("invalid");
    setBackupError(err?.message || "Invalid credentials or backup code.");
  }
}
```

---

## 2. Public Blockchain Verification Migration (Guide #5 Integration)

Currently, `src/App.tsx` and `src/services/contract.ts` rely on client-side ethers mock simulations with fake hardcoded names (`"Muhammad Aslam Khan"`). **Replace this entire mock pipeline with the live backend endpoint.**

### 2.1 Add Verification Method to `src/services/api.ts`
The backend provides a **public, unauthenticated on-chain verification endpoint**:
`GET /api/ledger/verify/:credentialId`

```ts
// In src/services/api.ts
export interface PublicVerificationResponse {
  success: boolean;
  verified: boolean;
  data?: {
    credentialId: string;
    issuedAt: string;
    onChainHash: string;
  };
  message?: string;
}

// In api object:
async verifyPublicCredential(credentialId: string): Promise<PublicVerificationResponse> {
  return request<PublicVerificationResponse>(
    `/api/ledger/verify/${encodeURIComponent(credentialId.trim())}`,
    { method: "GET" }
  );
}
```

### 2.2 Update `handleVerify` in `src/App.tsx`
Replace lines 178–240 in `src/App.tsx` with the live backend call:

```ts
// src/App.tsx (Updated handleVerify)
async function handleVerify(credentialId: string) {
  const timestamp = new Intl.DateTimeFormat("en-PK", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date());

  try {
    const res = await api.verifyPublicCredential(credentialId);

    if (res.success && res.verified && res.data) {
      const issueDate = new Date(res.data.issuedAt).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      setVerificationResult({
        status: "verified",
        credentialId: res.data.credentialId,
        issueDate,
        txHash: res.data.onChainHash,
        timestamp,
      });
    } else {
      setVerificationResult({
        status: "revoked", // or tampered
        credentialId,
        timestamp,
      });
    }
  } catch (err: any) {
    setVerificationResult({
      status: "revoked",
      credentialId,
      timestamp,
    });
  }
}
```

---

## 3. Blockchain Ledger Dashboard Migration (Guide #5 Integration)

Currently, `CredentialsScreen.tsx` uses a static hardcoded array (`const CREDENTIALS = [...]`). Replace this with live backend ledger endpoints.

### 3.1 Add Ledger Endpoints to `src/services/api.ts`

```ts
// src/services/api.ts (Ledger Types and Methods)
export interface IssueCredentialPayload {
  candidateId: string;
  credentialSubject: {
    skillName: string;
    issuer: string;
    awardLevel: string;
    [key: string]: any;
  };
}

export interface CredentialStatusResponse {
  success: boolean;
  data: {
    credential_id: string;
    credential_status: "PENDING_APPROVAL" | "APPROVED" | "REVOKED";
    issued_at: string;
    approved_at?: string;
    minting_status?: "QUEUED" | "BROADCASTED" | "MINTED" | "FAILED";
    tx_hash?: string;
    attempt_count: number;
  };
}

// In api object:
async issueCredential(payload: IssueCredentialPayload) {
  return request("/api/ledger/issue", {
    method: "POST",
    body: JSON.stringify(payload),
  });
},

async approveLedgerCredential(credentialId: string) {
  return request("/api/ledger/approve", {
    method: "POST",
    body: JSON.stringify({ credentialId }),
  });
},

async getLedgerCredentialStatus(credentialId: string): Promise<CredentialStatusResponse> {
  return request(`/api/ledger/${encodeURIComponent(credentialId)}`, {
    method: "GET",
  });
}
```

### 3.2 Live Status Polling in `src/screens/CredentialsScreen.tsx`
1. When rendering credentials, read `data.minting_status` and display the appropriate status badge:
   * `null` &rarr; 🟡 **Pending Approval**
   * `"QUEUED"` &rarr; 🔵 **Queued for Blockchain Minting**
   * `"BROADCASTED"` &rarr; 🟣 **Broadcasting (Polygon)**
   * `"MINTED"` &rarr; 🟢 **Anchored on Blockchain**
   * `"FAILED"` &rarr; 🔴 **Minting Failed (Retry Available)**
2. When `minting_status === "MINTED"` and `data.tx_hash` is present, display a direct link to the Polygon Amoy blockchain explorer:
   ```ts
   const polygonScanUrl = `https://amoy.polygonscan.com/tx/${data.tx_hash}`;
   ```

---

## 4. Master File Modification Map (Frontend Checklist)

| File | Current Status | Required Action to Align with Guide #6 |
| :--- | :--- | :--- |
| `src/services/authStore.ts` | Missing `refreshToken` | Persist `refreshToken` in `SessionState` and `sessionStorage`. |
| `src/services/api.ts` | Missing Guide 4 & 5 APIs | Add token refresh, revocation, backup codes, ledger issuance, ledger approval, and public verification methods. Add silent 401 refresh interceptor. |
| `src/App.tsx` | Mock verification & local logout | 1. Update `handleLogout()` to call `api.revokeSession()`.<br>2. Update `handleVerify()` to call `api.verifyPublicCredential()`. |
| `src/screens/MFAScreen.tsx` | Backup codes stubbed | Wire `handleBackupVerify()` to call `api.verifyBackupCode()`. |
| `src/screens/CredentialsScreen.tsx` | Static dummy data | Replace mock array with live calls to `api.getLedgerCredentialStatus()` and render real PolygonScan links. |
| `src/screens/SettingsScreen.tsx` | No backup codes UI | Add "Generate Backup Codes" modal and status counter using `api.generateBackupCodes()` and `api.getBackupCodeStatus()`. |
| `src/services/contract.ts` | Browser-side RPC mock | Deprecate in favor of the clean backend verification endpoint in `api.ts`. |

---

*Guide #6 generated for the frontend team based on complete architectural review, supervisor instructions, and backend commits through `9cd826d`.*
