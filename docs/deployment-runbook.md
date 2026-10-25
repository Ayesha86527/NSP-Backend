# NSP Backend — Production Deployment Runbook

Owner: Track B (Auth Hardening & Platform Foundation) · Applies to: NSP-Backend (Node.js 22 / Express 5)

This runbook takes a clean server to a running, verified backend. Follow the sections in order. Every command was written against the code in this repository; where something is **not yet automated**, it says so.

---

## 0. Architecture in one minute

- One Node.js process (modular monolith): `auth`, `candidate`, `ledger`, `verification`, `superAdmin` modules, an in-process `eventBus`, and a minting worker that polls the queue every 30 s.
- PostgreSQL (schemas `auth`, `candidate`, `ledger`), Redis (verification cache), AWS S3 (candidate/assessment photos via pre-signed URLs), Polygon Amoy (smart contract, written by the relayer wallet).
- The process is **stateful in two small ways** (in-memory rate-limit counters, minting timer). Run **one instance** until the limiter is moved to Redis (see §9).

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Node.js | 22 LTS (`node -v`) |
| PostgreSQL | 14+ (RDS), reachable from the server, TLS enabled |
| Redis | 6+ (ElastiCache or equivalent), reachable from the server |
| S3 bucket | Private bucket; the server's IAM role needs `s3:PutObject` on it |
| Polygon Amoy | RPC URL (HTTPS) + deployed `CertificateLogic` address (see `contract/README.md`) |
| Relayer wallet | Funded with POL; keep the key in a secret manager |
| TLS terminator | Load balancer / nginx in front of the app (the API itself speaks HTTP) |

## 2. Get the code

```bash
git clone <repo-url> /opt/nsp-backend && cd /opt/nsp-backend
git checkout <release-tag>
npm ci --omit=dev
```

## 3. Generate secrets (once per environment)

```bash
# MFA_ENCRYPTION_KEY — 64 hex chars (AES-256-GCM key protecting every MFA secret)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# CNIC_DEDUP_SECRET — >= 32 chars (HMAC key for duplicate-CNIC detection)
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# RS256 JWT key pair (works on Windows, macOS and Linux; no openssl needed)
node scripts/generateJwtKeys.js --out /etc/nsp/keys     # local dev: npm run keys:generate
sudo chmod 400 /etc/nsp/keys/private.key /etc/nsp/keys/public.key
sudo chown <service-user> /etc/nsp/keys/*.key
```

> ⚠️ **Never rotate `MFA_ENCRYPTION_KEY` or `CNIC_DEDUP_SECRET` casually.** Changing the first makes every stored MFA secret undecryptable (all users must re-enrol MFA). Changing the second breaks duplicate-candidate detection for already-enrolled CNICs.
> Rotating the JWT key pair logs everyone out (acceptable, but plan it).

## 4. Configure the environment

```bash
cp .env.production.example .env        # or inject via your secret manager / systemd EnvironmentFile
chmod 600 .env
$EDITOR .env                            # fill EVERY value; set JWT_KEYS_DIR=/etc/nsp/keys
```

Checklist of values that are easy to get wrong:

- `NODE_ENV=production` → forces `DB_SSL=true`, verified TLS to RDS and HTTPS-only CORS origins.
- `DB_SSL_CA` → path to the RDS CA bundle (download `global-bundle.pem` from AWS).
- `CORS_ALLOWED_ORIGINS` → the exact Issuer Portal and Verifier DApp origins, comma-separated, **no trailing slash, no path, no `*`**.
- `TRUST_PROXY=1` when behind exactly one load balancer. Without it every user shares one rate-limit bucket (the LB's IP).
- `RELAYER_PRIVATE_KEY`, `CERTIFICATE_LOGIC_CONTRACT_ADDRESS`, `POLYGON_AMOY_RPC_URL` → must match the deployed contract/network.

npm run check:env          # prints every problem at once and flags probable typos in variable names

```bash
node -e "require('dotenv').config(); require('./src/config/validateEnv')(); console.log('environment OK')"
```

The server runs the same check on boot and refuses to start if it fails.

## 5. Database

### 5.1 Fresh database

> ⚠️ **Gap:** the repository does not yet contain the complete baseline DDL for the three schemas (only incremental migrations). Until it is committed, produce it **once** from the existing dev database:
>
> ```bash
> pg_dump --schema-only --no-owner --no-privileges \
>         -n auth -n candidate -n ledger "$DEV_DATABASE_URL" \
>         > db/migrations/000_baseline_schema.sql
> ```
> Review it, commit it, and use it below. Running the incremental migrations alone on an empty database will fail.

```bash
export $(grep -v '^#' .env | xargs)          # or rely on dotenv: the scripts load .env themselves
psql "host=$DB_HOST port=${DB_PORT:-5432} dbname=$DB_NAME user=$DB_USER sslmode=verify-full sslrootcert=$DB_SSL_CA" \
     -f db/migrations/000_baseline_schema.sql
```

### 5.2 Incremental migrations (existing and new databases)

All migrations are idempotent (`IF NOT EXISTS`) and are applied with the app's own DB settings. Run **in this order**:

```bash
node scripts/run-migration.js auth/001_add_device_fingerprint_to_sessions.sql
node scripts/run-migration.js auth/002_super_admin_security.sql
node scripts/run-migration.js candidate/002_assessment_idempotency.sql
```

There is no migration-history table yet; re-running a file is safe. Take an RDS snapshot before every production migration.

## 6. Start the service

systemd example (`/etc/systemd/system/nsp-backend.service`):

```ini
[Unit]
Description=NSP Backend
After=network.target

[Service]
User=nsp
WorkingDirectory=/opt/nsp-backend
EnvironmentFile=/opt/nsp-backend/.env
ExecStart=/usr/bin/node src/app.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now nsp-backend
journalctl -u nsp-backend -f          # expect: "NSP backend listening on port 3000"
```

The process shuts down gracefully on `SIGTERM` (stops the minting timer, closes the HTTP server).

## 7. Seed the 5 testing hubs

Creates one **Trade Tester** and one **Center Superintendent** per hub (IDs 1–5): `tradetester.hub{N}@nsp.com`, `superintendent.hub{N}@nsp.com`.

```bash
node scripts/seedHubs.js                                   # dry run — shows what would be created
node scripts/seedHubs.js --apply --credentials-out /root/nsp-seed-credentials.json
```

- Idempotent: existing accounts are skipped, never modified. Safe to re-run.
- Each account gets a random one-time password. **Passwords are never printed** — they are written once to the credentials file (mode `600`; the script refuses to overwrite an existing file).
- Hand the passwords to each user over a secure channel, then **delete the file** (`shred -u`).
- At first login each user is walked through MFA enrolment automatically (`/api/auth/mfa/enroll/start` → `confirm`).
- Super Admin accounts are created separately with `scripts/create-superAdmin.js` and `scripts/activate-superAdmin-mfa.js`.

## 8. Post-deploy smoke test

npm start                                  # terminal 1
npm run smoke                              # terminal 2 (BASE_URL=https://api... for a deployed server)

```bash
# 1. Liveness
curl -s $API/health                                  # {"status":"ok",...}

# 2. Unknown routes return JSON, protected routes demand a token
curl -s -o /dev/null -w "%{http_code}\n" $API/api/nope                # 404
curl -s -o /dev/null -w "%{http_code}\n" $API/api/assessments/queue   # 401

# 3. CORS: allowed origin echoed, others refused
curl -si -H "Origin: https://issuer.example.gov.pk" $API/health | grep -i access-control-allow-origin
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" $API/health   # 403

# 4. Public verification works without login and is fast (< 2.0 s)
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "$API/api/verify/urn%3Auuid%3A<known-credential-id>"

# 5. Rate limit: the 61st request within a minute must return 429
for i in $(seq 1 65); do curl -s -o /dev/null -w "%{http_code} " -X POST $API/api/auth/login; done; echo
```

Then log in as a seeded Super Admin and check `GET /api/ledger/relayer-balance` (relayer wallet funded, `isLowGas:false`) and `GET /api/ledger/queue/health`.

Run the automated suite on the release candidate **before** deploying (needs no external services):

```bash
npm test          # 50+ tests, includes the full 5-stage lifecycle (test/e2e.lifecycle.test.js)
```

## 9. Operations

| Topic | What to know |
|---|---|
| **Logs** | stdout/stderr (journald). Auth and approval events are also in `auth.audit_logs` (`AUTH_*`, `ASSESSMENT_*`). 5xx details are logged server-side only; clients see `Internal server error`. |
| **DB pool** | `DB_POOL_MAX=20`, idle timeout 30 s per instance. Keep `instances × 20` below RDS `max_connections`. |
| **Rate limits** | 60 req/min/IP globally, plus separate 60/min buckets on `/api/auth/*` and `/api/verify/*`. Counters are in-memory **per process**; with N instances the effective limit is N×60. Use one instance, or move the store to Redis before scaling out. Hub offices share one NAT IP — raise `RATE_LIMIT_PER_MINUTE` only with lead approval. |
| **Low relayer gas** | Worker logs `LOW GAS ALERT` when balance < `MIN_GAS_THRESHOLD` POL. Top up the wallet printed in the log. |
| **Stuck minting** | `GET /api/ledger/queue/health` for counts; `POST /api/ledger/queue/trigger` forces a run. |
| **Locked users** | Super Admin endpoints `/api/super-admin/users/:id/unlock`, `/reset-mfa`, `/sessions/:id/revoke` (lost hub laptop). |
| **Rollback** | `git checkout <previous-tag> && npm ci --omit=dev && systemctl restart nsp-backend`. Migrations are additive/idempotent, so no schema rollback is normally needed; restore the pre-migration snapshot only if a migration itself failed. |



## 10. Known limitations at handover

1. **Approval → mint handshake:** `approveAssessment()` emits `assessment.approved` with the frozen payload (verified by `test/e2e.lifecycle.test.js`), but Track A's subscriber that turns the event into a minting-queue entry is not in the repository yet. Until it lands, credentials are issued/approved via `POST /api/ledger/issue` and `/api/ledger/approve`, and `assessment_records.status` is not flipped to `MINTED` (FR-CAND-08).
2. **NADRA:** `candidate/nadra/nadra.service.js` is still the development adapter (always verifies). Do not go live with real citizens until the production client is integrated.
3. **60-candidate hub quota (FR-CAND-01)** is not enforced in `candidate.service.js` yet.
4. **Baseline DDL** is not in the repo (see §5.1).
5. `Dockerfile` is an untested template; the process-based deployment above is the verified path.
