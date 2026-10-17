const assert = require('node:assert/strict');
const test = require('node:test');
const CandidateModel = require('../src/modules/candidate/candidate.model');
const LedgerModel = require('../src/modules/ledger/ledger.model');
const LedgerService = require('../src/modules/ledger/ledger.service');
const { requireRole } = require('../src/modules/auth/auth.middleware');

const candidateId = '123e4567-e89b-12d3-a456-426614174000';
const validInput = () => ({
    candidateId,
    credentialSubject: {
        skillName: ' Electrical Installation ',
        issuer: ' did:nsp:issuer:test ',
        awardLevel: 'Level 2'
    }
});

test('validates and normalizes the credential issue input', () => {
    assert.deepEqual(LedgerService.validateCredentialInput(validInput()), {
        candidateId,
        credentialSubject: {
            skillName: 'Electrical Installation',
            issuer: 'did:nsp:issuer:test',
            awardLevel: 'Level 2'
        }
    });
});

test('rejects non-object bodies, malformed candidate IDs, and credential subject arrays', () => {
    for (const body of [null, [], 'credential']) {
        assert.throws(
            () => LedgerService.validateCredentialInput(body),
            { statusCode: 400 }
        );
    }

    assert.throws(
        () => LedgerService.validateCredentialInput({
            ...validInput(),
            candidateId: 'not-a-uuid'
        }),
        { statusCode: 400 }
    );
    assert.throws(
        () => LedgerService.validateCredentialInput({
            candidateId,
            credentialSubject: []
        }),
        { statusCode: 400 }
    );
});

test('rejects blank required fields, client-controlled IDs, and oversized subjects', () => {
    const blankSkill = validInput();
    blankSkill.credentialSubject.skillName = '  ';
    assert.throws(
        () => LedgerService.validateCredentialInput(blankSkill),
        { statusCode: 400 }
    );

    const suppliedId = validInput();
    suppliedId.credentialSubject.id = 'did:attacker:credential';
    assert.throws(
        () => LedgerService.validateCredentialInput(suppliedId),
        { statusCode: 400 }
    );

    const tooLarge = validInput();
    tooLarge.credentialSubject.details = 'x'.repeat(16 * 1024);
    assert.throws(
        () => LedgerService.validateCredentialInput(tooLarge),
        { statusCode: 400 }
    );
});

test('canonicalizes nested objects independent of key insertion order', () => {
    assert.equal(
        LedgerService.stableStringify({ z: 1, nested: { b: 2, a: 1 } }),
        LedgerService.stableStringify({ nested: { a: 1, b: 2 }, z: 1 })
    );
});

test('issues credentials only for candidates in the issuer hub', async (t) => {
    const originalFindByIdInHub = CandidateModel.findByIdInHub;
    const originalCreateCredential = LedgerModel.createCredential;
    const saved = [];

    t.after(() => {
        CandidateModel.findByIdInHub = originalFindByIdInHub;
        LedgerModel.createCredential = originalCreateCredential;
    });

    CandidateModel.findByIdInHub = async (id, hubId) => (
        id === candidateId && hubId === 7 ? { candidate_id: id } : null
    );
    LedgerModel.createCredential = async (credential) => {
        saved.push(credential);
        return credential;
    };

    const credential = await LedgerService.issueCredentialOnly(
        validInput(),
        { userId: '987e6543-e21b-12d3-a456-426614174000', hubLocationId: 7 }
    );

    assert.equal(credential.candidateId, candidateId);
    assert.equal(credential.createdBy, '987e6543-e21b-12d3-a456-426614174000');
    assert.equal(credential.credentialSubject.credentialSubject.id, `did:nsp:candidate:${candidateId}`);
    assert.match(credential.rootHash, /^0x[0-9a-f]{64}$/);
    assert.equal(saved.length, 1);

    await assert.rejects(
        LedgerService.issueCredentialOnly(validInput(), {
            userId: '987e6543-e21b-12d3-a456-426614174000',
            hubLocationId: 8
        }),
        { statusCode: 404 }
    );
    assert.equal(saved.length, 1);
});

test('enforces role checks with 401 and 403 responses', () => {
    const guard = requireRole('SUPER_ADMIN');
    const createResponse = () => ({
        statusCode: null,
        body: null,
        status(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    });
    const unauthorized = createResponse();
    const forbidden = createResponse();
    let nextCalled = false;

    guard(
        { user: null },
        unauthorized,
        () => { nextCalled = true; }
    );
    assert.equal(unauthorized.statusCode, 401);
    guard(
        { user: { role: 'TRADE_TESTER' } },
        forbidden,
        () => { nextCalled = true; }
    );
    assert.equal(forbidden.statusCode, 403);
    guard(
        { user: { role: 'SUPER_ADMIN' } },
        {},
        () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);
});
