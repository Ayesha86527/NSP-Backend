# NSP — Frontend Integration Guide #2

**Audience:** Frontend team (Issuer Portal first)
**Supersedes:** Guide #1 — read this as a *delta*. Everything in Guide 1 not mentioned here still applies; two sections of Guide 1 are now **outdated** (flagged below).
**What's new since Guide 1:** the backend now issues real JWT tokens after MFA, the entire **Trade Tester workflow is live** (enrolment → assessment → submit), the backend is **deployed to AWS**, and MFA is now a real TOTP code.
**Not ready yet (do not build against):** Superintendent approval queue, ledger/minting, public verification API, S3 pre-signed uploads.

---

## ⚠️ Outdated sections in Guide 1

| Guide 1 said | Now true |
| --- | --- |
| "No session/token yet — treat session as client-side state" | **JWT tokens are now issued.** See §1. |
| Demo MFA code `123456` | **Gone.** MFA is now a real TOTP code from an authenticator app. See §2. |
| Base URL `http://localhost:3000` | Still valid locally; the backend is also **deployed on AWS** (dev). Ask the backend team for the current dev server URL. |

---

## 1. Auth v2 — real tokens

### 1.1 The login flow (IP-01 → IP-02) — same two steps, new payload

Step 1 `POST /api/auth/login` is unchanged (`{ email, password }` → `200` with `mfaRequired: true` + `user`).

Step 2 `POST /api/auth/verify-mfa` (`{ email, mfaCode }`) now returns **tokens**:

```json
{
  "success": true,
  "message": "Login successful",
  "accessToken": "<JWT>",
  "tokenType": "Bearer",
  "expiresIn": "15m",
  "user": {
    "id": "<uuid>",
    "email": "tradetester@nsp.com",
    "role": "TRADE_TESTER",
    "hubLocationId": 1
  }
}
```

**Frontend responsibilities:**
- Store `accessToken` (memory or `sessionStorage`; avoid `localStorage` if your security posture allows).
- Attach `Authorization: Bearer <accessToken>` to **every** request to `/api/candidates` and `/api/assessments`. Without it you get `401 {"success":false,"message":"Authentication required"}`.
- The JWT contains `sub`, `email`, `role`, `hubLocationId` — you can decode it client-side for UI role checks, but always trust the server's enforcement, not the token.
- On `401` mid-session, the token has expired (15 min) — currently the correct behavior is **redirect to login** (see 1.3 before building auto-refresh).

### 1.2 `user` shape change

`user.id` is now a **UUID from the database** (was `1`), and `user.hubLocationId` is included. Update the `User` interface from Guide 1:

```ts
interface User {
  id: string;            // UUID now
  email: string;
  role: "TRADE_TESTER" | "CENTER_SUPERINTENDENT" | "SUPER_ADMIN";
  hubLocationId: number; // 1..5
}
```

### 1.3 ⚠️ Do NOT integrate these yet — wired but not implemented

The routes below exist and respond, but their backend logic is **not implemented yet** — calling them returns HTTP 500 today:

- `POST /api/auth/refresh` (token refresh — coming soon)
- `POST /api/auth/revoke`
- `POST /api/auth/verify-backup-code`
- `POST /api/auth/backup-codes/generate` · `GET /api/auth/backup-codes/status`

**Do not build UI against them.** In particular, do **not** build auto-refresh-on-401 logic yet — for now, a 401 means "log in again." Guide 3 will announce these when they're real. (Heads-up for your sprint planning: when refresh lands, the flow will be `verify-mfa`-like: `POST /api/auth/refresh { refreshToken }` → new access token. Design your auth store so this slots in without a rewrite.)

### 1.4 MFA enrollment for demo/test users

Real TOTP means every tester account must be enrolled with an authenticator app (Google Authenticator etc.). The backend team enrolls accounts via a script that returns the TOTP secret — **ask them for the secret/QR of your demo account**, add it to your authenticator, and use the live 6-digit codes. There is no "no-MFA" path; this is by design (FR-AUTH-01, no opt-out).

---

## 2. Trade Tester workflow — LIVE endpoints

All routes below require `Authorization: Bearer <token>` and role `TRADE_TESTER` (you get `403 {"success":false,"message":"Only Trade Testers can..."}` otherwise). All responses follow the `{ success, message, ... }` envelope.

### 2.1 Enrol a candidate — `POST /api/candidates` → `201`

```json
{
  "fullName": "Ahmad Khan",
  "fatherName": "Muhammad Khan",
  "dob": "1998-04-12",
  "cnic": "35202-1234567-1",
  "photoS3Uri": "<see note>",
  "tradeCategory": "Electrician"
}
```

- Server-side rules: all fields required (`400`), identity must pass the NADRA verification step (`422` if not), duplicate CNIC rejected (`409`).
- The raw CNIC is never stored — the backend fingerprints it. Nothing for the frontend to do about that, but never cache/log the CNIC in app state longer than the form needs.
- **📷 Photo note:** `photoS3Uri` is a required string, but the **S3 pre-signed upload endpoint does not exist yet** (Guide 1 flagged it as coming). Until it lands, coordinate with the backend team: either they accept a placeholder URI for demo data, or you disable the photo upload control and send a placeholder. Building the real upload UI now would be wasted work — wait for Guide 3.
- The candidate is automatically assigned to **your hub** (`hubLocationId` from your token). There is no hub field to send.

### 2.2 Create an assessment — `POST /api/assessments` → `201`

```json
{
  "candidateId": "<uuid from enrolment>",
  "score": 85.5,
  "grade": "A"
}
```

Errors: `400` missing score/grade · `404` candidate not found · `403` candidate belongs to another hub.

### 2.3 List & read your assessments

- `GET /api/assessments` → `200`, all assessments **you** created (for the "my drafts" list).
- `GET /api/assessments/:id` → `200`, single record (ownership/hub-checked).

### 2.4 Edit a draft — `PATCH /api/assessments/:id` → `200`

```json
{ "score": 90, "grade": "A+" }
```

Only while `status = "DRAFT"` (`409` otherwise) and only if you created it (`403` otherwise).

### 2.5 Submit for approval — `POST /api/assessments/:id/submit` → `200`

No body. Flips `DRAFT → SUBMITTED`. After this the record leaves your hands and enters the (upcoming) Superintendent queue. `409` if not DRAFT.

### 2.6 The record shape you'll receive

```ts
interface Assessment {
  assessmentId: string;
  candidateId: string;
  score: number;
  grade: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "MINTED";
  rejectionReason?: string;   // set when REJECTED (in future flows)
  testerUserId: string;
  createdAt: string;
  submittedAt?: string;
}
```

Status drives your UI (per SDD Figure 13): `DRAFT` → editable + "Submit" button; `SUBMITTED` → read-only, "awaiting approval"; `REJECTED` → show `rejectionReason`, allow edit-resubmit (once the Superintendent endpoints land in Guide 3).

### 2.7 Error-code cheat sheet (all endpoints)

| Code | Meaning |
| --- | --- |
| `400` | Missing/invalid fields — show field-level validation |
| `401` | No/invalid/expired token → go to login |
| `403` | Wrong role or wrong hub — don't retry, it's a permissions wall |
| `404` | Candidate/assessment doesn't exist (or isn't yours) |
| `409` | State conflict (duplicate CNIC, editing non-DRAFT, resubmitting) |
| `422` | NADRA identity verification failed |
| `429` | Rate limit (60 req/min/IP) — back off |

---

## 3. Deployment — where to point the app

- Local development: `http://localhost:3000` (unchanged).
- The backend now runs on **AWS (EC2 + private RDS)** as a dev environment. Get the current base URL from the backend team and make it an env var (`VITE_API_BASE_URL`) — never hardcode either URL.
- CORS is currently open (dev posture). When origins are locked down, the backend team will tell you the exact origin strings they need from your deployed frontend.

---

## 4. What you can build now vs. wait

| Item | Screens | Status |
| --- | --- | --- |
| Login + MFA + token storage + authed fetch wrapper | IP-01, IP-02 | ✅ **Build now** |
| Candidate enrolment form (photo upload stubbed) | IP-05 | ✅ Build now (see §2.1 note) |
| Score entry: create / edit draft / submit + status chips | IP-06 | ✅ Build now |
| "My assessments" list | IP-04/06 | ✅ Build now |
| Backup-code recovery UI | IP-03 | ⛔ Wait — backend not implemented (§1.3) |
| Approval queue + approve/reject | IP-08–IP-10 | ⛔ Wait — Guide 3 (in build now) |
| Super Admin monitoring / revocation | IP-11–IP-13 | ⛔ Wait |
| Verifier DApp / wallet integration | VD-*, WW-* | ⛔ Wait — minting module in build |

## 5. Coming in Guide 3 (plan for these)

1. **Superintendent endpoints:** approval queue + approve/reject → unlocks IP-08–IP-10. Rejected records will arrive back as DRAFT **with `rejectionReason` set** — your draft-edit screen should already display that field (§2.6).
2. **Token refresh + backup codes** — the endpoints in §1.3 go live; your 401-handling upgrades from "redirect to login" to "refresh and retry once."
3. **S3 pre-signed photo upload** — a `POST` that returns an upload URL; the enrolment form's photo control goes live.
4. **Minting status** — `MINTED` status + receipt data will start appearing on records; treat `status` as an open enum.

---

*Guide #2 generated against the backend as of "Complete Trade Tester workflow". Verify endpoint behavior against the dev server if anything differs — this guide describes code that is merged and deployed.*
