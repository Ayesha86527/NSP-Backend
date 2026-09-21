# NSP — Frontend Integration Guide #1

**Audience:** Frontend team (Issuer Portal, Verifier DApp)
**Scope:** Backend API + smart-contract surfaces that are **implemented, tested, and ready to integrate today**.
**Reference documents:** SRS v2.1 (FR-AUTH-01/02/06), SDD Section 6.1 & 8.1 (screens IP-01, IP-02), Section 6.4/6.5.3 (Verifier DApp).
**Status of the rest of the system:** Candidate, Ledger, and Verification modules are not implemented yet. Do **not** build against them. See "Not available yet" at the end.

---

## 1. Running the backend locally

```bash
git clone <repo-url>
cd NSP-Backend
npm install
npm run dev        # or: node src/app.js
```

- The server starts on **port 3000** by default (`PORT` env var to override). No `.env` file is required for these endpoints.
- All responses are JSON. Every body follows the same envelope: a `success` boolean plus a `message`, with payload fields alongside.
- Every request passes through security headers (helmet) and a **global rate limit of 60 requests/minute per IP** (HTTP `429` when exceeded). This matches NFR-PER-02 — do not add client-side retries that hammer the API.

Base URL for all examples: `http://localhost:3000`

---

## 2. Ready-to-integrate: Health check

### `GET /health`

Simple liveness probe — useful for connectivity indicators or deployment smoke tests.

**Response `200`:**

```json
{ "status": "ok", "timestamp": "2026-09-20T05:12:22.494Z" }
```

---

## 3. Ready-to-integrate: Login + MFA (Issuer Portal screens IP-01 / IP-02)

Login is a **two-step flow**, exactly as designed in SDD Figure 4:

```
IP-01 (login form) → POST /api/auth/login → mfaRequired: true → IP-02 (MFA screen) → POST /api/auth/verify-mfa → user object
```

### 3.1 Step 1 — `POST /api/auth/login`

Validates email + password.

**Request body:**

| Field    | Type   | Required |
| -------- | ------ | -------- |
| `email`    | string | yes      |
| `password` | string | yes      |

**Success — `200`:**

```json
{
  "success": true,
  "message": "Password verified. MFA verification required.",
  "mfaRequired": true,
  "user": {
    "id": 1,
    "name": "Trade Tester",
    "email": "tradetester@nsp.com",
    "role": "TRADE_TESTER"
  }
}
```

**Errors:**

| Status | Body                                              | When                          |
| ------ | ------------------------------------------------- | ----------------------------- |
| `400`  | `{ "success": false, "message": "Email and password are required" }` | Missing/empty fields |
| `401`  | `{ "success": false, "message": "Invalid email or password" }`       | Wrong credentials    |

### 3.2 Step 2 — `POST /api/auth/verify-mfa`

Verifies the 6-digit MFA code for the same user.

**Request body:**

| Field     | Type   | Required |
| --------- | ------ | -------- |
| `email`     | string | yes      |
| `mfaCode`   | string | yes      |

**Success — `200`:**

```json
{
  "success": true,
  "message": "Login successful",
  "user": {
    "id": 1,
    "name": "Trade Tester",
    "email": "tradetester@nsp.com",
    "role": "TRADE_TESTER"
  }
}
```

**Errors:**

| Status | Body                                        | When                        |
| ------ | ------------------------------------------- | --------------------------- |
| `400`  | `{ "success": false, "message": "Email and MFA code are required" }` | Missing/empty fields |
| `401`  | `{ "success": false, "message": "Invalid MFA code" }`                | Wrong code           |
| `401`  | `{ "success": false, "message": "Invalid user" }`                    | Unknown email        |

### 3.3 Demo credentials (current build)

These are hardcoded in the current backend — the MFA step accepts exactly one code:

| Field     | Value                  |
| --------- | ---------------------- |
| Email     | `tradetester@nsp.com`  |
| Password  | `TradeTester123`       |
| MFA code  | `123456`               |

> ⚠️ The demo account role is `TRADE_TESTER` only. The Superintendent and Super Admin dashboards (IP-08–IP-13) cannot be logged into yet — their backend module is not implemented.

### 3.4 TypeScript interfaces (suggested)

```ts
interface User {
  id: number;
  name: string;
  email: string;
  role: "TRADE_TESTER" | "CENTER_SUPERINTENDENT" | "SUPER_ADMIN";
}

interface LoginResponse {
  success: boolean;
  message: string;
  mfaRequired?: boolean;
  user?: User;
}

interface MfaResponse {
  success: boolean;
  message: string;
  user?: User;
}
```

### 3.5 Important limitation — no session/token yet

A successful `verify-mfa` returns the user object **only**. There is no JWT, refresh token, or session cookie yet (FR-AUTH-02 is the next backend increment). Consequences for the frontend:

- You can fully build and demo the login flow (IP-01 → IP-02) and the post-login redirect for `TRADE_TESTER`.
- Keep your auth layer token-agnostic: design the auth store so a token can be slotted in later (e.g., `setSession({ user, token?: string })`).
- There is currently nothing to attach to subsequent request headers, and no logout/session endpoint. Treat "session" as client-side state for now.
- Expect the response shape to grow (access/refresh tokens) without breaking — new fields are additive.

### 3.6 Example flow (curl)

```bash
# Step 1
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"tradetester@nsp.com","password":"TradeTester123"}'

# Step 2
curl -X POST http://localhost:3000/api/auth/verify-mfa \
  -H "Content-Type: application/json" \
  -d '{"email":"tradetester@nsp.com","mfaCode":"123456"}'
```

---

## 4. Ready-to-integrate: Credential verification (Verifier DApp, screens VD-01–VD-03)

The smart contracts (`contract/contracts/`) are implemented, and their 21-case test suite passes. The Verifier DApp's core call is a **read-only on-chain lookup** — no login, no payment (FR-VER-01/03).

### 4.1 Contract interface

```solidity
function verifyCertificate(bytes32 certId)
  external view returns (bool isValid, uint256 issuedAt, bytes32 dataHash);
```

- `certId` and `dataHash` are `bytes32` (SHA-256 digests; on the backend side, `dataHash` is the SHA-256 of the credential payload per FR-LEDG-02).
- Unknown/never-minted id → returns `isValid = false` (does **not** revert) — safe to render as "Not found".
- Revoked certificate → `isValid = false`.
- Certificates are also emitted as events: `CertificateMinted(bytes32 indexed certId, bytes32 dataHash)` and `CertificateRevoked(bytes32 indexed certId)`.

### 4.2 ethers.js (v6) usage sketch

```ts
import { Contract, BrowserProvider } from "ethers";

const LOGIC_ABI = [
  "function verifyCertificate(bytes32 certId) view returns (bool isValid, uint256 issuedAt, bytes32 dataHash)",
];

// For a pure read-only DApp (no wallet needed), use a JsonRpcProvider pointed at your RPC endpoint.
const provider = new BrowserProvider(window.ethereum);
const logic = new Contract(LOGIC_CONTRACT_ADDRESS, LOGIC_ABI, provider);

const certId = /* bytes32 from QR scan or manual entry */;
const [isValid, issuedAt, dataHash] = await logic.verifyCertificate(certId);
```

Render the three UI states from this single call, per SDD Figure 16:

| Result                                   | UI state (VD-03) |
| ---------------------------------------- | ---------------- |
| `isValid === true`                       | Valid ✅          |
| `isValid === false` (revoked or unknown) | Invalid / Not found ❌ |

### 4.3 ⚠️ Deployment prerequisite — not ready yet

**No deployment script exists yet** (`deploy.ts` was an empty stub; the only Ignition module is still the template `Counter.ts`), and the contracts have not been deployed to Polygon Amoy or any persistent network.

Until the backend team ships a deploy script and a stable contract address:

- You can integrate against a **local Hardhat node** (`cd contract && npx hardhat node`) with a throwaway deployment — the contract addresses will change on every restart, so read them from config, never hardcode.
- Do **not** hardcode contract addresses; make them env-driven (`VITE_VERIFIER_CONTRACT_ADDRESS` etc.) from day one.

---

## 5. What frontend work can start today

| Item                                        | Screens     | Ready? |
| ------------------------------------------- | ----------- | ------ |
| Login form + MFA challenge + error states   | IP-01, IP-02| ✅ Yes  |
| Backup-code recovery screen (IP-03)         | IP-03       | ⛔ Backend not implemented (FR-AUTH-08) |
| Trade Tester dashboard / enrolment / scores | IP-04–IP-07 | ⛔ Candidate module not implemented |
| Superintendent approval queue + signing     | IP-08–IP-10 | ⛔ Ledger module not implemented |
| Super Admin monitoring / revocation         | IP-11–IP-13 | ⛔ Not implemented |
| Verifier landing / scanner / manual entry   | VD-01–VD-03 | ✅ Logic ready, ⚠️ needs a contract deployment (local node OK) |
| Worker Mobile Wallet                        | WW-*        | ⛔ Not implemented |

---

## 6. Coming next from the backend (plan your auth store for this)

1. **RS256 JWT access token (15 min) + rotating refresh token** returned from `verify-mfa` (FR-AUTH-02) — additive fields, envelope unchanged.
2. **Real TOTP** verification (replacing the demo `123456`) and account lockout after 5 failed attempts (FR-AUTH-01/06) — expect a `401` variant with a lockout message.
3. **RBAC middleware + protected routes** — you will need to attach `Authorization: Bearer <token>` to every authenticated call.
4. **Candidate & ledger module endpoints** — will unlock IP-03–IP-13.
5. **Contract deployment script + stable Amoy testnet addresses** — will unlock real Verifier DApp integration.

---

*Guide generated 2026-09-20 against commit history through `testing done` (contracts + 21 passing tests, auth mock endpoints).*
