# Backend Sprint Roadmap — Sprint 5 (next)

**Duration:** 2 weeks · **Team:** 2 developers (A, B) · **Baseline:** commit `94c7899`
**Sprint goal (one sentence):** *An approved assessment travels all the way onto the blockchain on a local network — enrol → submit → approve → queue → mint → MINTED — and the broken auth endpoints are fixed.*

**Where we are:** Auth (login/MFA/JWT/audit), Trade Tester workflow (enrol, CNIC hashing, S3 uploads, media, offline replay, assessments), and the Superintendent approval loop (queue/approve/reject) are done and deployed. Contracts are implemented with 21 passing tests but **not deployed**. The ledger and verification modules are empty. Known defects: the approval event is emitted into a void (`eventBus.js` is an empty file), and five auth routes return 500 because their service functions were never written.

---

## Track B (critical path) — Ledger / Minting module

*B owns the `ledger` schema only. Reference: `docs/module_briefs_superintendent_ledger.md` §3 — the shared event contract there is already implemented by A; do not change its payload shape.*

| # | Task | Detail | Done when |
|---|---|---|---|
| B1 | **Implement `src/events/eventBus.js`** — 🔴 fix-first, day 1 | Node `EventEmitter` singleton exporting `on`/`emit`. Today `assessment.service.js` emits `assessment.approved` into an empty module — the call throws and is swallowed, so approvals work but events are lost. This is a live defect, not future work. | Approval logs `[EVENT] assessment.approved emitted` with no error; a test subscriber receives the payload |
| B2 | **Ledger schema migration** | SQL script creating `ledger.minting_queue` + `ledger.credentials` exactly per SDD Tables 10/11. Follow the pattern of the existing `auth` schema scripts. | Script runs clean on the dev RDS; columns match SDD |
| B3 | **Queue intake** — subscriber to `assessment.approved` | Compile hash of the payload, insert `minting_queue` row (`QUEUED`) + `credentials` row. Idempotent on `assessment_id` UNIQUE (duplicate event → skip, no error). | Re-approving/emitting twice produces one queue row |
| B4 | **W3C VC compiler + SHA-256** (FR-LEDG-01/02) | Pure function: payload → Verifiable Credential JSON (W3C VC / Blockcerts-style). Deterministic. Store full JSON in `credentials.w3c_vc_json`. **Mandatory test: output contains no PII fields** (name/CNIC/photo absent). | Unit tests incl. the no-PII assertion pass |
| B5 | **Minting worker + relayer** (FR-LEDG-03/04/06) | Poll QUEUED rows → `mintCertificate(certId, dataHash)` via ethers.js → `BROADCASTED` → `CONFIRMED` (record `polygon_tx_hash`, `block_number`) or `FAILED` with `retry_count` bounded at 3, then escalate via audit log. Gas-balance check before broadcast, warn below threshold (FR-CHAIN-07). | Worker drives a row through the full lifecycle on a local Hardhat node; forced-failure retry path demonstrated |
| B6 | **MINTED flip via event, not SQL** | On CONFIRMED, emit `credential.minted`; a small listener in the candidate module flips `assessment_records.status = MINTED`. No cross-schema writes. | End-to-end: approve → (seconds later) assessment shows MINTED |

**Track B definition of done:** the full local-network journey works from a running server; every queue transition is audit-logged; zero PII in the `ledger` schema (verify by inspecting rows after a demo run).

---

## Track A — Auth completion, contract deployment, hardening

*A owns the `auth`/`candidate` sides and the contract tooling.*

| # | Task | Detail | Done when |
|---|---|---|---|
| A1 | **Implement the 5 missing auth service functions** — 🔴 day 1–2 | `refreshAccessToken`, `revokeUserSession`, `generateBackupCodes`, `verifyBackupCode`, `getUserBackupCodeStatus`. Routes and controller calls already exist (currently 500). Refresh: rotating refresh token stored hashed in `auth.sessions`; revoke: mark session revoked. Backup codes: 10 single-use, salted-hash stored, per FR-AUTH-08. | All five endpoints return 200 paths; `POST /api/auth/refresh` issues a new access token from a valid refresh token; used refresh token is rejected (rotation) |
| A2 | **Account lockout** (FR-AUTH-06) | Lock after 5 consecutive failed logins; admin or time-based unlock. Track failed attempts on the user row or a counter table; audit-log the lock event. | 5 wrong passwords → 423/403 lock response; correct password after unlock works; lock is audited |
| A3 | **Contract deploy script** | Ignition module or `scripts/deploy.ts`: deploy `CertificateStorage` → `CertificateLogic` → authorize logic on storage. Works against **local Hardhat node** and **Polygon Amoy** (`SEPOLIA_*`-style env vars; add `POLYGON_RPC_URL`, `GAS_WALLET_PRIVATE_KEY`, `CONTRACT_*_ADDRESS`). | One command deploys wired+authorized contracts locally; second run targets Amoy; addresses land in env, never hardcoded |
| A4 | **Step-up MFA hook on approve/reject** (FR-ISS-07) | Require a fresh MFA verification (e.g., `mfaCode` in the approve/reject body validated server-side, or a short-lived step-up token) before the state change. Keep it additive — Guide 3 told the frontend this was coming. | Approve/reject without valid step-up MFA → 401-class error; with it → works. Update frontend Guide 4 notes |
| A5 | *(stretch)* Device-fingerprint capture (FR-AUTH-04) | Record `device_fingerprint` + IP into `auth.sessions` at login; warn (don't block) on mismatch this sprint. | Session rows carry fingerprint data |

**Team hygiene (30 minutes, day 1, whoever is free):**
- 🔴 **`.env` leak:** `git rm --cached .env`, commit, force the ignore; then **rotate all exposed values** (DB password, `MFA_ENCRYPTION_KEY`, `JWT_SECRET`, `CNIC_DEDUP_SECRET`) and re-run `createTradeTester.js` + update the deployed EC2 env. This has been flagged three sprints running — it gets a named owner today.
- Refresh root `node_modules` (`npm install`) — `bcrypt`/`jsonwebtoken`/`otplib` are missing locally.

---

## Schedule (2 weeks)

| Days | Track B | Track A |
|---|---|---|
| 1–2 | B1 event bus (defect) → B2 migration → B3 intake | Hygiene fixes → A1 auth functions |
| 3–5 | B4 VC compiler + tests | A1 finished → A2 lockout |
| 6–8 | B5 worker + relayer (local node) | A3 deploy script (local, then Amoy) |
| 9–10 | B6 MINTED flip + **joint end-to-end demo** | A4 step-up MFA → A5 stretch |

**Mid-sprint checkpoint (day 5):** B's queue intake consuming real events from A's approve endpoint — the seam proven before the relayer exists.
**Sprint review demo:** one live run — enrol → submit → approve → queue row → local mint → `MINTED` — plus a refresh-token round-trip and a lockout demo.

---

## Explicitly out of scope this sprint (do not start)

- Public verification API and Verifier DApp support (next sprint — it's small once the ledger exists).
- Worker wallet backend (activation links, PDF, status refresh).
- Contract hardening: proxy upgradeability, multisig, hub DID signature verification — **scheduled as the pre-mainnet gate** with the independent security review, not sprint work.
- RS256 JWT migration (current HS256 is a known, accepted deviation — plan for the sprint after next; it pairs with serving public keys).
- CI/CD pipeline, Dockerfile, load testing.
- Frontend work of any kind (covered by Guides 2–3).

## Risks & dependencies

| Risk | Mitigation |
|---|---|
| Amoy RPC/funding delays B5 | Develop entirely against the local Hardhat node — equivalent for all logic; Amoy is configuration |
| Step-up MFA (A4) changes frontend contract | Additive only; announce in Guide 4 before it goes live on dev |
| No automated tests baseline | Tests ride along with B3/B4/B5 and A1/A2 (service layer) — don't defer to a "test sprint" |
| Event payload drift between A and B | Frozen in `module_briefs_superintendent_ledger.md` §1 — changes require both devs to agree explicitly |
