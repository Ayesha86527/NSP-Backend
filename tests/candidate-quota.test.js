
const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../src/config/db');
const modelPath = require.resolve('../src/modules/candidate/candidate.model');

function loadModelWithMockedDatabase(initialCounts = {}) {
    const counts = new Map(
        Object.entries(initialCounts).map(([hub, count]) => [
            Number(hub),
            count
        ])
    );

    const insertsByHub = new Map();
    const queries = [];
    const hubLocks = new Map();

    function acquireHubLock(hubId) {
        const previous = hubLocks.get(hubId) || Promise.resolve();

        let release;
        const current = new Promise(resolve => {
            release = resolve;
        });

        hubLocks.set(hubId, previous.then(() => current));

        return previous.then(() => release);
    }

    const client = {
        currentHubId: null,
        releaseLock: null,

        async query(sql, params = []) {
            queries.push({ sql, params });

            if (sql === 'BEGIN' || sql === 'COMMIT') {
                if (sql === 'COMMIT') {
                    this.releaseLock?.();
                    this.releaseLock = null;
                }
                return { rows: [] };
            }

            if (sql === 'ROLLBACK') {
                this.releaseLock?.();
                this.releaseLock = null;
                return { rows: [] };
            }

            if (sql.includes('pg_advisory_xact_lock')) {
                this.currentHubId = params[1];
                this.releaseLock = await acquireHubLock(this.currentHubId);
                return { rows: [] };
            }

            if (sql.includes('SELECT COUNT(*)::int AS count')) {
                const hubId = params[0];
                return { rows: [{ count: counts.get(hubId) || 0 }] };
            }

            if (sql.includes('INSERT INTO candidate.candidates')) {
                const hubId = params[8];
                const nextInsert = (insertsByHub.get(hubId) || 0) + 1;

                insertsByHub.set(hubId, nextInsert);
                counts.set(hubId, (counts.get(hubId) || 0) + 1);

                return {
                    rows: [{
                        candidate_id: `hub-${hubId}-test-${nextInsert}`,
                        testing_hub_id: hubId
                    }]
                };
            }

            throw new Error(`Unexpected SQL in test: ${sql}`);
        },

        release() {
            this.releaseLock?.();
            this.releaseLock = null;
        }
    };

    const mockedPool = {
        async connect() {
            return {
                query: client.query.bind({
                    currentHubId: null,
                    releaseLock: null
                }),
                release() {}
            };
        },
        async query() {
            throw new Error('Unexpected direct pool.query call');
        }
    };

    // Each connection needs its own transaction/lock state.
    mockedPool.connect = async () => {
        const connection = {
            releaseLock: null,
            async query(sql, params = []) {
                queries.push({ sql, params });

                if (sql === 'BEGIN') return { rows: [] };

                if (sql === 'COMMIT' || sql === 'ROLLBACK') {
                    this.releaseLock?.();
                    this.releaseLock = null;
                    return { rows: [] };
                }

                if (sql.includes('pg_advisory_xact_lock')) {
                    this.releaseLock = await acquireHubLock(params[1]);
                    return { rows: [] };
                }

                if (sql.includes('SELECT COUNT(*)::int AS count')) {
                    return {
                        rows: [{ count: counts.get(params[0]) || 0 }]
                    };
                }

                if (sql.includes('INSERT INTO candidate.candidates')) {
                    const hubId = params[8];
                    const nextInsert = (insertsByHub.get(hubId) || 0) + 1;

                    insertsByHub.set(hubId, nextInsert);
                    counts.set(hubId, (counts.get(hubId) || 0) + 1);

                    return {
                        rows: [{
                            candidate_id: `hub-${hubId}-test-${nextInsert}`,
                            testing_hub_id: hubId
                        }]
                    };
                }

                throw new Error(`Unexpected SQL in test: ${sql}`);
            },
            release() {
                this.releaseLock?.();
                this.releaseLock = null;
            }
        };

        return connection;
    };

    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: mockedPool
    };

    delete require.cache[modelPath];
    const model = require(modelPath);

    return {
        model,
        queries,
        getCount: hubId => counts.get(hubId) || 0,
        getInsertCount: hubId => insertsByHub.get(hubId) || 0,
        cleanup() {
            delete require.cache[modelPath];
            delete require.cache[dbPath];
        }
    };
}

function candidateForHub(testingHubId = 1) {
    return {
        fullName: 'Quota Test Candidate',
        fatherName: 'Quota Test Father',
        dob: '2000-01-15',
        cnicSaltedHash: 'test-salted-hash',
        cnicDedupHash: `test-dedup-hash-${testingHubId}-${Math.random()}`,
        cnicBlindSalt: 'test-blind-salt',
        photoS3Uri: 's3://test-bucket/test-photo.jpg',
        tradeCategory: 'Electrician',
        testingHubId
    };
}

test('59 candidates: allows one more enrolment', async () => {
    const mock = loadModelWithMockedDatabase({ 1: 59 });

    try {
        const result = await mock.model.createCandidate(candidateForHub(1));
        assert.equal(result.testing_hub_id, 1);
        assert.equal(mock.getCount(1), 60);
        assert.equal(mock.getInsertCount(1), 1);
    } finally {
        mock.cleanup();
    }
});

test('60 candidates: rejects enrolment with HTTP 409', async () => {
    const mock = loadModelWithMockedDatabase({ 1: 60 });

    try {
        await assert.rejects(
            mock.model.createCandidate(candidateForHub(1)),
            error => error.statusCode === 409
        );
        assert.equal(mock.getInsertCount(1), 0);
    } finally {
        mock.cleanup();
    }
});

test('61 candidates: rejects enrolment with HTTP 409', async () => {
    const mock = loadModelWithMockedDatabase({ 1: 61 });

    try {
        await assert.rejects(
            mock.model.createCandidate(candidateForHub(1)),
            error => error.statusCode === 409
        );
        assert.equal(mock.getInsertCount(1), 0);
    } finally {
        mock.cleanup();
    }
});

test('a full hub does not prevent enrolment in another hub', async () => {
    const mock = loadModelWithMockedDatabase({ 1: 60, 2: 10 });

    try {
        await assert.rejects(
            mock.model.createCandidate(candidateForHub(1)),
            error => error.statusCode === 409
        );

        const result = await mock.model.createCandidate(candidateForHub(2));

        assert.equal(result.testing_hub_id, 2);
        assert.equal(mock.getCount(1), 60);
        assert.equal(mock.getCount(2), 11);
    } finally {
        mock.cleanup();
    }
});

test('concurrent enrolments cannot exceed 60 in the simulated lock', async () => {
    const mock = loadModelWithMockedDatabase({ 1: 59 });

    try {
        const results = await Promise.allSettled([
            mock.model.createCandidate(candidateForHub(1)),
            mock.model.createCandidate(candidateForHub(1))
        ]);

        assert.equal(
            results.filter(result => result.status === 'fulfilled').length,
            1
        );

        assert.equal(
            results.filter(
                result => result.status === 'rejected' &&
                    result.reason.statusCode === 409
            ).length,
            1
        );

        assert.equal(mock.getCount(1), 60);
        assert.equal(mock.getInsertCount(1), 1);
    } finally {
        mock.cleanup();
    }
});
