/**
 * End-to-end lifecycle test (Roadmap Phase 2, Days 8-9, Track B).
 *
 * Drives the REAL Express app over HTTP through the full 5-stage journey:
 *   Enrol Candidate -> Score Draft -> Submit -> Superintendent Approve
 *   -> Relayer Mint -> Public Verify
 * plus offline-queue idempotency (replayed clientRequestId) and the
 * rejection workflow (SUBMITTED -> REJECTED -> DRAFT).
 *
 * Real: routes, middleware (RS256 JWT, RBAC, CORS, rate limit, error handler),
 *       controllers, services, the W3C credential compiler, the minting relayer
 *       and the public verification service.
 * Faked at the I/O boundary only: PostgreSQL (in-memory models), Redis,
 *       the Polygon contract, S3 pre-signing.
 */

process.env.NSP_TEST_RATE_LIMIT = '100000';
const {
    TEST_CNIC,
    stubModule,
    createFakeRedis,
    signAccessToken
} = require('./helpers/testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ethers } = require('ethers');

// ---------------------------------------------------------------------------
// Boundary fakes (installed BEFORE the app is loaded)
// ---------------------------------------------------------------------------

const fakeRedis = stubModule('config/redis.js', createFakeRedis());

/** In-memory stand-in for the CertificateLogic contract on Polygon. */
const chain = new Map(); // certId(bytes32) -> { hash, issuedAt }
let mintCalls = 0;
const fakeContract = {
    async verifyCertificate(certId) {
        const entry = chain.get(certId);
        return entry
            ? [true, BigInt(entry.issuedAt), entry.hash]
            : [false, 0n, ethers.ZeroHash];
    },
    async mintCertificate(certId, dataHash) {
        mintCalls += 1;
        chain.set(certId, { hash: dataHash, issuedAt: Math.floor(Date.now() / 1000) });
        return {
            wait: async () => ({
                status: 1,
                hash: `0x${crypto.randomBytes(32).toString('hex')}`
            })
        };
    }
};
stubModule('modules/ledger/blockchain/contract.js', {
    getProvider: () => null,
    getReadOnlyContractInstance: () => fakeContract,
    getContractInstance: async () => fakeContract,
    checkRelayerBalance: async () => 10n ** 18n
});

const pool = require('../src/config/db');
const candidateModel = require('../src/modules/candidate/candidate.model');
const assessmentModel = require('../src/modules/candidate/assessment.model');
const assessmentMediaModel = require('../src/modules/candidate/assessment-media.model');
const s3Service = require('../src/modules/candidate/s3.service');
const auditModel = require('../src/modules/auth/audit.model');
const ledgerModel = require('../src/modules/ledger/ledger.model');
const ledgerService = require('../src/modules/ledger/ledger.service');
const eventBus = require('../src/events/eventBus');
const { processMintingQueue } = require('../src/modules/ledger/blockchain/relayer');

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------

const db = {
    users: new Map(),
    sessions: new Map(),
    candidates: new Map(),
    assessments: new Map(),
    media: new Map(),
    credentials: new Map(),
    queue: new Map(),
    audit: []
};

const makeActor = (role, hubLocationId, label) => {
    const user = {
        user_id: crypto.randomUUID(),
        email: `${label}@nsp.test`,
        role,
        hub_location_id: hubLocationId,
        admin_locked: false,
        token_version: 0,
        is_mfa_active: true,
        mfa_enrollment_pending: false
    };
    const sessionId = crypto.randomUUID();
    db.users.set(user.user_id, user);
    db.sessions.set(sessionId, { session_id: sessionId, user_id: user.user_id });
    return {
        user,
        token: signAccessToken({ userId: user.user_id, sessionId })
    };
};

const tester = makeActor('TRADE_TESTER', 1, 'tester-hub1');
const otherTester = makeActor('TRADE_TESTER', 2, 'tester-hub2');
const superintendent = makeActor('CENTER_SUPERINTENDENT', 1, 'supt-hub1');
const otherSuperintendent = makeActor('CENTER_SUPERINTENDENT', 2, 'supt-hub2');

// auth.middleware talks to PostgreSQL directly: answer its two lookups.
pool.query = async (sql, params) => {
    if (sql.includes('FROM auth.users')) {
        const user = db.users.get(params[0]);
        return { rows: user ? [user] : [] };
    }
    if (sql.includes('FROM auth.sessions')) {
        const session = db.sessions.get(params[0]);
        return { rows: session && session.user_id === params[1] ? [session] : [] };
    }
    throw new Error(`Unexpected SQL in e2e test: ${sql.slice(0, 80)}`);
};

// ---- candidate / assessment models -----------------------------------------

candidateModel.findByDedupHash = async (hash) =>
    [...db.candidates.values()].find((c) => c.cnic_dedup_hash === hash) || null;

candidateModel.createCandidate = async (input) => {
    const row = {
        candidate_id: crypto.randomUUID(),
        full_name: input.fullName,
        father_name: input.fatherName,
        dob: input.dob,
        photo_s3_uri: input.photoS3Uri,
        trade_category: input.tradeCategory,
        testing_hub_id: input.testingHubId,
        cnic_salted_hash: input.cnicSaltedHash,
        cnic_dedup_hash: input.cnicDedupHash,
        cnic_blind_salt: input.cnicBlindSalt
    };
    db.candidates.set(row.candidate_id, row);
    const { cnic_salted_hash, cnic_dedup_hash, cnic_blind_salt, ...publicRow } = row;
    return publicRow;
};

candidateModel.findById = async (id) => db.candidates.get(id) || null;
candidateModel.findByIdInHub = async (id, hubId) => {
    const row = db.candidates.get(id);
    return row && row.testing_hub_id === hubId ? { candidate_id: id } : null;
};

const withCandidateFields = (assessment) => {
    const candidate = db.candidates.get(assessment.candidate_id);
    return {
        ...assessment,
        trade_category: candidate.trade_category,
        testing_hub_id: candidate.testing_hub_id
    };
};

assessmentModel.findByClientRequestId = async ({ testerUserId, clientRequestId }) =>
    [...db.assessments.values()].find(
        (a) => a.tester_user_id === testerUserId && a.client_request_id === clientRequestId
    ) || null;

assessmentModel.createAssessment = async ({ candidateId, score, grade, testerUserId, clientRequestId }) => {
    const row = {
        assessment_id: crypto.randomUUID(),
        candidate_id: candidateId,
        score,
        grade,
        tester_user_id: testerUserId,
        superintendent_user_id: null,
        status: 'DRAFT',
        rejection_reason: null,
        submitted_at: null,
        approved_at: null,
        client_request_id: clientRequestId
    };
    db.assessments.set(row.assessment_id, row);
    return { ...row };
};

assessmentModel.findById = async (id) => {
    const row = db.assessments.get(id);
    return row ? { ...row } : null;
};

assessmentModel.updateDraft = async ({ assessmentId, score, grade, testerUserId }) => {
    const row = db.assessments.get(assessmentId);
    if (!row || row.tester_user_id !== testerUserId || row.status !== 'DRAFT') return null;
    Object.assign(row, { score, grade });
    return { ...row };
};

assessmentModel.submitDraft = async ({ assessmentId, testerUserId }) => {
    const row = db.assessments.get(assessmentId);
    if (!row || row.tester_user_id !== testerUserId || row.status !== 'DRAFT') return null;
    Object.assign(row, { status: 'SUBMITTED', submitted_at: new Date().toISOString() });
    return { ...row };
};

assessmentModel.findSubmittedForSuperintendent = async (hubId) =>
    [...db.assessments.values()]
        .filter((a) => a.status === 'SUBMITTED' && db.candidates.get(a.candidate_id).testing_hub_id === hubId)
        .map((a) => ({ ...a, full_name: db.candidates.get(a.candidate_id).full_name }));

assessmentModel.approveAssessment = async ({ assessmentId, superintendentUserId }) => {
    const row = db.assessments.get(assessmentId);
    if (!row || row.status !== 'SUBMITTED') return null;
    Object.assign(row, {
        status: 'APPROVED',
        superintendent_user_id: superintendentUserId,
        approved_at: new Date().toISOString()
    });
    return withCandidateFields(row);
};

assessmentModel.rejectAssessment = async ({ assessmentId, superintendentUserId, rejectionReason }) => {
    const row = db.assessments.get(assessmentId);
    if (!row || row.status !== 'SUBMITTED') return null;
    Object.assign(row, {
        status: 'DRAFT',
        superintendent_user_id: superintendentUserId,
        rejection_reason: rejectionReason
    });
    return withCandidateFields(row);
};

assessmentMediaModel.findOneByAssessment = async (assessmentId) =>
    db.media.get(assessmentId) || null;
assessmentMediaModel.findByAssessment = async (assessmentId) =>
    db.media.has(assessmentId) ? [db.media.get(assessmentId)] : [];
assessmentMediaModel.createMedia = async ({ assessmentId, mediaType, mediaS3Uri }) => {
    const row = { media_id: crypto.randomUUID(), assessment_id: assessmentId, media_type: mediaType, media_s3_uri: mediaS3Uri };
    db.media.set(assessmentId, row);
    return row;
};

s3Service.createAssessmentPhotoUploadUrl = async ({ assessmentId, userId }) => ({
    uploadUrl: 'https://s3.test.example/presigned',
    key: `assessment-media/${userId}/${assessmentId}/x.jpg`,
    s3Uri: `s3://nsp-test-bucket/assessment-media/${userId}/${assessmentId}/x.jpg`,
    expiresIn: 300
});
s3Service.createPhotoUploadUrl = async ({ userId }) => ({
    uploadUrl: 'https://s3.test.example/presigned',
    key: `candidate-photos/${userId}/x.jpg`,
    s3Uri: `s3://nsp-test-bucket/candidate-photos/${userId}/x.jpg`,
    expiresIn: 300
});

auditModel.createAuditLog = async (entry) => {
    db.audit.push(entry);
    return entry;
};

// ---- ledger model (queue state machine mirrors ledger.model.js) -----------

let queueSeq = 0;

ledgerModel.createCredential = async ({ credentialId, candidateId, createdBy, credentialSubject, rootHash }) => {
    const row = {
        credential_id: credentialId,
        candidate_id: candidateId,
        created_by: createdBy,
        credential_subject: credentialSubject,
        root_hash: rootHash,
        status: 'PENDING_APPROVAL'
    };
    db.credentials.set(credentialId, row);
    return row;
};

ledgerModel.approveAndQueueCredential = async ({ credentialId, approverId }) => {
    const credential = db.credentials.get(credentialId);
    if (!credential) throw Object.assign(new Error('Credential not found.'), { statusCode: 404 });
    let item = [...db.queue.values()].find((q) => q.credential_id === credentialId);
    if (!item) {
        queueSeq += 1;
        item = {
            id: queueSeq,
            credential_id: credentialId,
            payload: {
                credentialId,
                rootHash: credential.root_hash,
                w3cCredential: credential.credential_subject
            },
            status: 'QUEUED',
            tx_hash: null,
            attempt_count: 0
        };
        db.queue.set(item.id, item);
        credential.status = 'APPROVED';
        credential.approved_by = approverId;
    }
    return item;
};

ledgerModel.getPendingQueueItems = async () =>
    [...db.queue.values()].filter((q) => ['QUEUED', 'FAILED'].includes(q.status) && q.attempt_count < 5);

ledgerModel.claimQueueItem = async (id) => {
    const item = db.queue.get(id);
    if (!item || !['QUEUED', 'FAILED'].includes(item.status)) return undefined;
    item.status = 'BROADCASTED';
    item.attempt_count += 1;
    return item;
};

ledgerModel.updateQueueStatus = async (id, status, txHash = null, lastError = null) => {
    const item = db.queue.get(id);
    item.status = status;
    item.tx_hash = txHash || item.tx_hash;
    item.last_error = lastError;
    if (status === 'MINTED') db.credentials.get(item.credential_id).status = 'MINTED';
};

ledgerModel.getCredentialByStringId = async (id) => db.credentials.get(id);

// ---------------------------------------------------------------------------
// Track A handshake stand-in
// ---------------------------------------------------------------------------
// The roadmap's Monday handshake: Track A subscribes to 'assessment.approved'
// and queues the credential. Track A's subscriber is not in this repo yet, so
// this test registers an equivalent one to prove Track B's emitted payload is
// sufficient to drive the ledger end-to-end.

const PAYLOAD_CONTRACT_KEYS = [
    'approvedAt', 'assessmentId', 'candidateId', 'grade', 'hubId',
    'score', 'superintendentUserId', 'tradeCategory'
];

const receivedEvents = [];
const credentialByAssessment = new Map();
const handshakeWaiters = new Map();

eventBus.on('assessment.approved', async (payload) => {
    receivedEvents.push(payload);
    const approver = {
        userId: payload.superintendentUserId,
        role: 'CENTER_SUPERINTENDENT',
        hubLocationId: payload.hubId
    };
    const issued = await ledgerService.issueCredentialOnly(
        {
            candidateId: payload.candidateId,
            credentialSubject: {
                skillName: payload.tradeCategory,
                issuer: 'National Skills Passport',
                grade: payload.grade,
                score: payload.score
            }
        },
        approver
    );
    await ledgerService.approveAndQueueCredential(issued.credential_id, approver);
    credentialByAssessment.set(payload.assessmentId, issued.credential_id);
    handshakeWaiters.get(payload.assessmentId)?.();
});

const waitForHandshake = (assessmentId) =>
    new Promise((resolve, reject) => {
        if (credentialByAssessment.has(assessmentId)) return resolve();
        const timer = setTimeout(() => reject(new Error('handshake timeout')), 3000);
        handshakeWaiters.set(assessmentId, () => { clearTimeout(timer); resolve(); });
    });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const app = require('../src/app');
let server;
let base;

test.before(async () => {
    server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end().catch(() => {});
});

const call = async (method, path, { actor, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
            ...headers
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: json };
};

const candidateInput = {
    fullName: 'Ayesha Khan',
    fatherName: 'Imran Khan',
    dob: '2001-04-12',
    cnic: TEST_CNIC,
    photoS3Uri: 's3://nsp-test-bucket/candidate-photos/x/photo.jpg',
    tradeCategory: 'Electrician'
};

/** Enrol -> draft -> photo -> submit; returns { candidateId, assessmentId }. */
const submitNewAssessment = async ({ candidateId, clientRequestId }) => {
    const draft = await call('POST', '/api/assessments', {
        actor: tester,
        body: { candidateId, score: 82, grade: 'A', clientRequestId }
    });
    assert.equal(draft.status, 201);
    const assessmentId = draft.body.assessment.assessment_id;

    const media = await call('POST', `/api/assessments/${assessmentId}/media`, {
        actor: tester,
        body: { mediaS3Uri: `s3://nsp-test-bucket/assessment-media/${assessmentId}.jpg` }
    });
    assert.equal(media.status, 201);

    const submit = await call('POST', `/api/assessments/${assessmentId}/submit`, { actor: tester });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.assessment.status, 'SUBMITTED');
    return assessmentId;
};

// ---------------------------------------------------------------------------
// Scenario 1 - the full 5-stage lifecycle
// ---------------------------------------------------------------------------

const state = {};

test('stage 1: Trade Tester enrols a candidate (CNIC hashed, never stored raw)', async () => {
    const response = await call('POST', '/api/candidates', { actor: tester, body: candidateInput });

    assert.equal(response.status, 201);
    state.candidateId = response.body.candidate.candidate_id;
    assert.equal(response.body.candidate.testing_hub_id, tester.user.hub_location_id);

    // API response and stored record must not expose the CNIC.
    assert.ok(!JSON.stringify(response.body).includes(TEST_CNIC));
    const stored = db.candidates.get(state.candidateId);
    assert.match(stored.cnic_salted_hash, /^[0-9a-f]{64}$/);
    assert.match(stored.cnic_dedup_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(TEST_CNIC));

    // Same CNIC cannot be enrolled twice.
    const duplicate = await call('POST', '/api/candidates', { actor: tester, body: candidateInput });
    assert.equal(duplicate.status, 409);
});

test('stage 2: Trade Tester scores a draft and attaches evidence', async () => {
    const draft = await call('POST', '/api/assessments', {
        actor: tester,
        body: { candidateId: state.candidateId, score: 70, grade: 'B', clientRequestId: 'lifecycle-1' }
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.replayed, false);
    assert.equal(draft.body.assessment.status, 'DRAFT');
    state.assessmentId = draft.body.assessment.assessment_id;

    const edit = await call('PATCH', `/api/assessments/${state.assessmentId}`, {
        actor: tester,
        body: { score: 88, grade: 'A' }
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.assessment.score, 88);

    // Submitting without the evidence photo is refused.
    const early = await call('POST', `/api/assessments/${state.assessmentId}/submit`, { actor: tester });
    assert.equal(early.status, 409);

    const upload = await call('POST', `/api/assessments/${state.assessmentId}/photo-upload-url`, { actor: tester });
    assert.equal(upload.status, 200);
    const media = await call('POST', `/api/assessments/${state.assessmentId}/media`, {
        actor: tester,
        body: { mediaS3Uri: upload.body.s3Uri }
    });
    assert.equal(media.status, 201);
});

test('stage 3: Trade Tester submits; it appears only in its own hub queue', async () => {
    const submit = await call('POST', `/api/assessments/${state.assessmentId}/submit`, { actor: tester });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.assessment.status, 'SUBMITTED');

    const queue = await call('GET', '/api/assessments/queue', { actor: superintendent });
    assert.equal(queue.status, 200);
    assert.ok(queue.body.assessments.some((a) => a.assessment_id === state.assessmentId));

    const otherQueue = await call('GET', '/api/assessments/queue', { actor: otherSuperintendent });
    assert.ok(!otherQueue.body.assessments.some((a) => a.assessment_id === state.assessmentId));
});

test('stage 4: Superintendent approves and the frozen event contract is emitted', async () => {
    // Authorisation boundaries first.
    assert.equal((await call('POST', `/api/assessments/${state.assessmentId}/approve`, { actor: tester })).status, 403);
    assert.equal((await call('POST', `/api/assessments/${state.assessmentId}/approve`)).status, 401);
    assert.equal(
        (await call('POST', `/api/assessments/${state.assessmentId}/approve`, { actor: otherSuperintendent })).status,
        403
    );
    assert.equal(receivedEvents.length, 0, 'no event may fire for refused approvals');

    const approve = await call('POST', `/api/assessments/${state.assessmentId}/approve`, { actor: superintendent });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.assessment.status, 'APPROVED');

    await waitForHandshake(state.assessmentId);
    assert.equal(receivedEvents.length, 1);
    assert.deepEqual(Object.keys(receivedEvents[0]).sort(), PAYLOAD_CONTRACT_KEYS);
    assert.equal(receivedEvents[0].assessmentId, state.assessmentId);
    assert.equal(receivedEvents[0].candidateId, state.candidateId);
    assert.equal(receivedEvents[0].hubId, 1);
    assert.equal(receivedEvents[0].tradeCategory, 'Electrician');
    assert.equal(receivedEvents[0].superintendentUserId, superintendent.user.user_id);

    // Approval is audit-logged.
    assert.ok(db.audit.some((e) => e.eventType === 'ASSESSMENT_APPROVED'));

    // A second approval is refused and must not emit a second event.
    const again = await call('POST', `/api/assessments/${state.assessmentId}/approve`, { actor: superintendent });
    assert.equal(again.status, 409);
    assert.equal(receivedEvents.length, 1);
});

test('stage 5a: relayer mints the queued credential on-chain', async () => {
    state.credentialId = credentialByAssessment.get(state.assessmentId);
    assert.match(state.credentialId, /^urn:uuid:/);

    const queued = [...db.queue.values()].find((q) => q.credential_id === state.credentialId);
    assert.equal(queued.status, 'QUEUED');

    await processMintingQueue();

    assert.equal(queued.status, 'MINTED');
    assert.match(queued.tx_hash, /^0x[0-9a-f]{64}$/);
    assert.equal(db.credentials.get(state.credentialId).status, 'MINTED');
    assert.equal(mintCalls, 1);

    // Zero PII on-chain / in the credential: only an opaque DID and the hash.
    const credentialJson = JSON.stringify(db.credentials.get(state.credentialId).credential_subject);
    assert.ok(!credentialJson.includes(TEST_CNIC));
    assert.ok(!credentialJson.includes('Ayesha'));
    assert.ok(!credentialJson.includes('Imran'));
    assert.ok(credentialJson.includes(`did:nsp:candidate:${state.candidateId}`));

    // Re-running the worker never double-mints.
    await processMintingQueue();
    assert.equal(mintCalls, 1);
});

test('stage 5b: public verification needs no login and answers VALID in < 2.0s', async () => {
    fakeRedis.store.clear();
    const url = `/api/verify/${encodeURIComponent(state.credentialId)}`;

    const started = process.hrtime.bigint();
    const response = await call('GET', url); // no Authorization header
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(response.status, 200);
    assert.equal(response.body.verified, true);
    assert.equal(response.body.status, 'VALID');
    assert.equal(response.body.data.credentialId, state.credentialId);
    assert.ok(elapsedMs < 2000, `verification took ${elapsedMs.toFixed(0)}ms (SLA < 2000ms)`);

    // Second lookup is served from Redis.
    const cached = await call('GET', url);
    assert.equal(cached.status, 200);
    assert.equal(cached.body.status, 'VALID');

    // Unknown credential id -> 404, never a crash.
    const missing = await call('GET', `/api/verify/${encodeURIComponent('urn:uuid:00000000-0000-4000-8000-000000000000')}`);
    assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// Scenario 2 - offline queue idempotency (replayed clientRequestId)
// ---------------------------------------------------------------------------

test('offline sync: replaying the same clientRequestId never creates a duplicate', async () => {
    const second = await call('POST', '/api/candidates', {
        actor: tester,
        body: { ...candidateInput, cnic: '3520198765432', fullName: 'Bilal Ahmed' }
    });
    assert.equal(second.status, 201);
    const candidateId = second.body.candidate.candidate_id;

    const body = { candidateId, score: 61, grade: 'C', clientRequestId: 'offline-req-42' };
    const before = db.assessments.size;

    const first = await call('POST', '/api/assessments', { actor: tester, body });
    assert.equal(first.status, 201);
    assert.equal(first.body.replayed, false);

    // The phone reconnects and replays the queued request several times.
    for (let i = 0; i < 3; i += 1) {
        const replay = await call('POST', '/api/assessments', { actor: tester, body });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.replayed, true);
        assert.equal(replay.body.assessment.assessment_id, first.body.assessment.assessment_id);
    }

    assert.equal(db.assessments.size, before + 1, 'exactly one record despite 4 identical requests');

    // Concurrent replays are also safe at the HTTP layer.
    const results = await Promise.all(
        Array.from({ length: 5 }, () => call('POST', '/api/assessments', { actor: tester, body }))
    );
    assert.ok(results.every((r) => r.body.assessment.assessment_id === first.body.assessment.assessment_id));
    assert.equal(db.assessments.size, before + 1);

    // Idempotency is scoped to the tester: a different tester may reuse the id string.
    const foreign = await call('POST', '/api/assessments', {
        actor: otherTester,
        body: { candidateId, score: 61, grade: 'C', clientRequestId: 'offline-req-42' }
    });
    assert.equal(foreign.status, 403, 'other hub cannot assess this candidate');

    // Missing clientRequestId is rejected.
    const missing = await call('POST', '/api/assessments', {
        actor: tester,
        body: { candidateId, score: 61, grade: 'C' }
    });
    assert.equal(missing.status, 400);
});

// ---------------------------------------------------------------------------
// Scenario 3 - rejection workflow (SUBMITTED -> REJECTED -> DRAFT)
// ---------------------------------------------------------------------------

test('rejection workflow: SUBMITTED -> REJECTED -> DRAFT -> resubmit -> approve', async () => {
    const enrol = await call('POST', '/api/candidates', {
        actor: tester,
        body: { ...candidateInput, cnic: '3520155555551', fullName: 'Sara Malik' }
    });
    const candidateId = enrol.body.candidate.candidate_id;
    const assessmentId = await submitNewAssessment({ candidateId, clientRequestId: 'reject-flow-1' });
    const eventsBefore = receivedEvents.length;

    // A reason is mandatory.
    const noReason = await call('POST', `/api/assessments/${assessmentId}/reject`, {
        actor: superintendent,
        body: { rejectionReason: '   ' }
    });
    assert.equal(noReason.status, 400);
    assert.equal(db.assessments.get(assessmentId).status, 'SUBMITTED');

    // Another hub's superintendent cannot reject it.
    const foreign = await call('POST', `/api/assessments/${assessmentId}/reject`, {
        actor: otherSuperintendent,
        body: { rejectionReason: 'Not my hub' }
    });
    assert.equal(foreign.status, 403);

    // Valid rejection returns the record to DRAFT with the reason kept.
    const reject = await call('POST', `/api/assessments/${assessmentId}/reject`, {
        actor: superintendent,
        body: { rejectionReason: 'Evidence photo is unclear' }
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.assessment.status, 'DRAFT');
    assert.equal(reject.body.assessment.rejection_reason, 'Evidence photo is unclear');

    const auditTypes = db.audit.map((e) => e.eventType);
    assert.ok(auditTypes.includes('ASSESSMENT_REJECTED'));
    assert.ok(auditTypes.includes('ASSESSMENT_RETURNED_TO_DRAFT'));
    assert.equal(receivedEvents.length, eventsBefore, 'rejection must not emit assessment.approved');

    // A DRAFT can no longer be rejected or approved.
    assert.equal((await call('POST', `/api/assessments/${assessmentId}/reject`, {
        actor: superintendent, body: { rejectionReason: 'again' }
    })).status, 409);
    assert.equal((await call('POST', `/api/assessments/${assessmentId}/approve`, { actor: superintendent })).status, 409);

    // Tester corrects the score and resubmits; this time it is approved.
    const fix = await call('PATCH', `/api/assessments/${assessmentId}`, {
        actor: tester,
        body: { score: 91, grade: 'A' }
    });
    assert.equal(fix.status, 200);
    const resubmit = await call('POST', `/api/assessments/${assessmentId}/submit`, { actor: tester });
    assert.equal(resubmit.status, 200);
    assert.equal(resubmit.body.assessment.status, 'SUBMITTED');

    const approve = await call('POST', `/api/assessments/${assessmentId}/approve`, { actor: superintendent });
    assert.equal(approve.status, 200);
    await waitForHandshake(assessmentId);
    assert.equal(receivedEvents.length, eventsBefore + 1);
});

// ---------------------------------------------------------------------------
// Event bus isolation (SDD 3.3)
// ---------------------------------------------------------------------------

test('a failing event listener never breaks approval or other listeners', async () => {
    const enrol = await call('POST', '/api/candidates', {
        actor: tester,
        body: { ...candidateInput, cnic: '3520111111119', fullName: 'Zain Ali' }
    });
    const candidateId = enrol.body.candidate.candidate_id;
    const assessmentId = await submitNewAssessment({ candidateId, clientRequestId: 'bus-isolation-1' });

    const originalError = console.error;
    console.error = () => {};
    const crashing = () => { throw new Error('listener exploded'); };
    const rejecting = async () => { throw new Error('async listener exploded'); };
    eventBus.on('assessment.approved', crashing);
    eventBus.on('assessment.approved', rejecting);

    try {
        const approve = await call('POST', `/api/assessments/${assessmentId}/approve`, { actor: superintendent });
        assert.equal(approve.status, 200);
        assert.equal(approve.body.assessment.status, 'APPROVED');
        await waitForHandshake(assessmentId); // healthy listener still ran
    } finally {
        eventBus.off('assessment.approved', crashing);
        eventBus.off('assessment.approved', rejecting);
        console.error = originalError;
    }
});
