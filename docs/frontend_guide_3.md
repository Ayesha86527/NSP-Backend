# NSP — Frontend Integration Guide #3

**Audience:** Frontend team (Issuer Portal — Trade Tester + Superintendent screens)
**Supersedes:** Guide #2 — read as a delta. Anything in Guide 2 not mentioned here still applies.
**What's new since Guide 2:** the **Superintendent approval workflow is live** (queue / approve / reject), **S3 pre-signed photo uploads are live** for both candidate and assessment photos, assessment **media** endpoints exist, and assessment creation is now **offline-replay-safe**.
**Still not ready (unchanged from Guide 2):** token refresh / revoke / backup codes (routes exist but return 500 — do not build against them), ledger/minting (`MINTED` status won't appear yet), public verification API, Super Admin screens.

---

## ⚠️ Outdated sections in Guide 2

| Guide 2 said | Now true |
| --- | --- |
| "Photo upload: stub it, wait for Guide 3" | **Live.** Two-step pre-signed upload flow — see §2. |
| "Approval queue: wait — Guide 3" | **Live.** Superintendent endpoints — see §1. |
| "Edit-resubmit after rejection (once Superintendent lands)" | **Live.** A rejected record returns to you as `DRAFT` with `rejectionReason` set — see §1.3. |
| `POST /api/assessments` body had 3 fields | **Now requires `clientRequestId`** (offline-replay safety) — see §4. |

---

## 1. Superintendent approval workflow (screens IP-08 – IP-10)

All routes require `Authorization: Bearer <token>` with role `CENTER_SUPERINTENDENT` (`403` otherwise). Hub scoping is server-enforced: a superintendent only ever sees and acts on their own hub's records.

### 1.1 Approval queue — `GET /api/assessments/queue` → `200`

Returns all **SUBMITTED** assessments for the superintendent's hub (candidate trade + hub included for display):

```json
{
  "success": true,
  "assessments": [
    {
      "assessment_id": "<uuid>",
      "candidate_id": "<uuid>",
      "score": 87,
      "grade": "Distinction",
      "tester_user_id": "<uuid>",
      "superintendent_user_id": null,
      "status": "SUBMITTED",
      "rejection_reason": null,
      "submitted_at": "2026-09-25T10:14:00Z",
      "approved_at": null,
      "trade_category": "Electrician",
      "testing_hub_id": 3
    }
  ]
}
```

> Note the **snake_case** field names on these records (matches the database columns). Build your mapper once and reuse it — all assessment payloads use this shape.

UI mapping (SDD IP-09): this array *is* the approval queue. Empty array = "no pending approvals" state.

### 1.2 Approve — `POST /api/assessments/:assessmentId/approve` → `200`

No body. On success the record becomes `APPROVED` (terminal on the backend until minting exists) and is stamped with the approving superintendent:

```json
{ "success": true, "assessment": { "status": "APPROVED", "superintendent_user_id": "<uuid>", "approved_at": "...", "...": "..." } }
```

**Errors:** `404` not found · `403` another hub's record · `409` not SUBMITTED (already approved/rejected/draft) · `409` explicitly if MINTED.

### 1.3 Reject — `POST /api/assessments/:assessmentId/reject` → `200`

Body requires a non-empty reason:

```json
{ "rejectionReason": "Score entry does not match attached evidence photo" }
```

Server behavior — important for your UI: the rejection and the bounce-back happen **atomically in one step**. The record is set to `REJECTED` with the reason, then immediately auto-returned to `DRAFT` (per SDD §6.2.3). The response therefore returns:

```json
{
  "success": true,
  "assessment": {
    "status": "DRAFT",
    "rejection_reason": "Score entry does not match attached evidence photo",
    "superintendent_user_id": "<uuid>",
    "...": "..."
  }
}
```

**So the superintendent UI should show a transient "Rejected — returned to tester" confirmation, and the tester's draft list will show the record as `DRAFT` with the reason attached.** Do not expect to ever poll a record in `REJECTED` state — it's a momentary internal state, not a resting state.

**Errors:** `400` missing/blank reason · `404` · `403` wrong hub · `409` not SUBMITTED / MINTED.

### 1.4 Status-driven UI rules (updated state machine, SDD Figure 13)

| Status | Who sees it | Allowed actions |
| --- | --- | --- |
| `DRAFT` | Trade Tester | Edit (`PATCH`), Submit, upload photo/media |
| `SUBMITTED` | Superintendent (queue) | Approve, Reject. Tester: read-only |
| `APPROVED` | Both (read-only) | None — awaiting minting (future) |
| `MINTED` | Both (read-only) | None — will appear once the ledger module ships |

---

## 2. Photo upload flow (FR-CAND-02) — two steps, browser → S3 directly

The backend never touches photo bytes. You get a pre-signed URL, upload straight to S3 from the browser, then send the resulting `s3Uri` string in the enrolment/media call.

### 2.1 Candidate photo (before enrolment)

**Step 1 — `POST /api/candidates/photo-upload-url`** (no body) → `200`:

```json
{
  "success": true,
  "uploadUrl": "https://<bucket>.s3.<region>.amazonaws.com/candidate-photos/...?X-Amz-...",
  "key": "candidate-photos/<userId>/<uuid>.jpg",
  "s3Uri": "s3://<bucket>/candidate-photos/<userId>/<uuid>.jpg",
  "expiresIn": 300
}
```

**Step 2 — upload the file to `uploadUrl` directly:**

```ts
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/jpeg" },   // must match exactly
  body: file                                    // raw File/Blob, no FormData
});
```

**Step 3 —** use `s3Uri` as the `photoS3Uri` field in `POST /api/candidates` (replacing the placeholder from Guide 2).

### 2.2 Assessment evidence photo

Identical flow, scoped to an assessment: **`POST /api/assessments/:assessmentId/photo-upload-url`** → same `{ uploadUrl, key, s3Uri, expiresIn }` → PUT the file → **`POST /api/assessments/:assessmentId/media`** with `{ "mediaS3Uri": "<s3Uri>" }` → `201` with the media record.

Rules:
- **DRAFT only** (`409` otherwise) and only your own assessments (`403`).
- **MVP limit: exactly one evidence photo per assessment.** Requesting a second upload URL for an assessment that already has one returns `409` ("Assessment already has media attached").
- The upload URL is valid for **5 minutes** (`expiresIn: 300`) — request it and use it immediately, don't pre-fetch at form load.
- `Content-Type` must be `image/jpeg` exactly — a mismatch makes S3 reject the PUT with a signature error (looks like a 403 from AWS, not from our API).

### 2.3 List media — `GET /api/assessments/:assessmentId/media` → `200`

Returns the media records for that assessment (use to show the attached evidence photo in draft review / record detail).

---

## 4. Offline-replay safety — `clientRequestId` is now REQUIRED (breaking change)

`POST /api/assessments` now **requires** a `clientRequestId` (HTTP `400` without it). This makes the offline queue safe:

```json
{
  "candidateId": "<uuid>",
  "score": 85.5,
  "grade": "A",
  "clientRequestId": "<uuid generated by the frontend>"
}
```

**The contract with the backend:**

1. Generate a fresh UUID **per logical assessment** (at form-open or draft-creation time), store it with the local record.
2. Reuse the **same** `clientRequestId` on every retry of that assessment — that's the whole point.
3. First successful send → `201`, `replayed: false`, new record.
4. Same request re-sent (queue retry after a drop, double-tap, replayed sync) → **`200`, `replayed: true`**, and `assessment` is the **original record**. Nothing is duplicated.
5. Treat `201` and `200` identically as "saved" — only the flag differs. Never retry on 200/201; only retry on network failure or 5xx.

This is the backend half of the SDD §6.2.4 offline flow (Figure 8): your IndexedDB queue can now replay blindly and safely.

---

## 5. Error-code additions (on top of Guide 2's cheat sheet)

| Code | New meanings this release |
| --- | --- |
| `400` | + blank `rejectionReason`; + missing `clientRequestId` |
| `403` | + superintendent acting on another hub's record |
| `409` | + approving/rejecting a non-SUBMITTED record; + second evidence photo; + acting on a MINTED record |

---

## 6. Build-now / wait table (updated)

| Item | Screens | Status |
| --- | --- | --- |
| Approval queue + approve + reject-with-reason | IP-08 – IP-10 | ✅ **Build now** (§1) |
| Photo upload (candidate + assessment evidence) | IP-05, IP-06 | ✅ **Build now** (§2) |
| Offline queue with `clientRequestId` replay | IP-05/06 offline mode | ✅ **Build now** (§4) |
| Login + MFA + bearer token | IP-01, IP-02 | ✅ (Guide 2) |
| Enrolment, drafts, submit | IP-04 – IP-07 | ✅ (Guide 2) |
| Backup-code recovery UI | IP-03 | ⛔ Still wait (endpoints 500) |
| Auto-refresh on 401 | — | ⛔ Still wait |
| Minting status / receipts | — | ⛔ Ledger module in build |
| Super Admin screens | IP-11 – IP-13 | ⛔ Wait |
| Verifier DApp / wallet APIs | VD-*, WW-* | ⛔ Wait |

## 7. Coming in Guide 4 (plan ahead)

1. **Minting status** — ledger module lands: `APPROVED` records will transition to `MINTED`; expect new fields (tx hash, credential id). Treat `status` as an open enum (already advised in Guide 2 — this is when it starts paying off).
2. **Token refresh + backup codes** — the 500-ing endpoints go live; 401 handling upgrades to "refresh once, then login."
3. **Public verification API** — unlocks the Verifier DApp screens (VD-01–VD-03).

---

*Guide #3 generated against the backend as of commit `94c7899` ("Implement assessment approval workflow and auth updates"). All shapes verified against the merged code.*
