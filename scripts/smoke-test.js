/**
 * Post-start smoke test against a RUNNING server (Roadmap Phase 2 exit check).
 *   npm start                      (terminal 1)
 *   npm run smoke                  (terminal 2)
 *   BASE_URL=https://api.example.gov.pk ALLOWED_ORIGIN=https://issuer.example.gov.pk npm run smoke
 *
 * Needs no credentials and writes nothing. Public verification latency is
 * measured against the < 2.0 s target (NFR-PER-01) using an unknown id.
 */
require('dotenv').config();

const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const ALLOWED_ORIGIN =
    process.env.ALLOWED_ORIGIN ||
    (process.env.CORS_ALLOWED_ORIGINS || '').split(',')[0].trim();

const results = [];
const check = async (name, fn) => {
    try {
        const detail = await fn();
        results.push({ name, ok: true, detail });
        console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
    } catch (error) {
        results.push({ name, ok: false });
        console.log(`FAIL  ${name}  -> ${error.message}`);
    }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
    console.log(`Smoke testing ${BASE_URL}\n`);

    await check('GET /health returns {status:"ok"}', async () => {
        const res = await fetch(`${BASE_URL}/health`);
        const body = await res.json();
        expect(res.status === 200 && body.status === 'ok', `status ${res.status}`);
    });

    await check('Helmet security headers present', async () => {
        const res = await fetch(`${BASE_URL}/health`);
        expect(res.headers.get('x-content-type-options') === 'nosniff', 'x-content-type-options missing');
    });

    await check('Unknown route returns JSON 404', async () => {
        const res = await fetch(`${BASE_URL}/api/does-not-exist`);
        const body = await res.json();
        expect(res.status === 404 && body.success === false, `status ${res.status}`);
    });

    await check('POST /api/auth/login with no body returns 400 (not 500)', async () => {
        const res = await fetch(`${BASE_URL}/api/auth/login`, { method: 'POST' });
        expect(res.status === 400, `status ${res.status}`);
    });

    await check('Protected route rejects missing token with 401', async () => {
        const res = await fetch(`${BASE_URL}/api/assessments/queue`);
        expect(res.status === 401, `status ${res.status}`);
    });

    await check('CORS refuses an unknown origin (403)', async () => {
        const res = await fetch(`${BASE_URL}/health`, { headers: { Origin: 'https://evil.example' } });
        expect(res.status === 403, `status ${res.status}`);
        expect(res.headers.get('access-control-allow-origin') === null, 'CORS header leaked');
    });

    if (ALLOWED_ORIGIN) {
        await check('CORS accepts the allow-listed origin', async () => {
            const res = await fetch(`${BASE_URL}/health`, { headers: { Origin: ALLOWED_ORIGIN } });
            expect(res.headers.get('access-control-allow-origin') === ALLOWED_ORIGIN, 'origin not echoed');
        });
    }

    await check('Public verify answers without login in < 2.0 s', async () => {
        const started = Date.now();
        const res = await fetch(`${BASE_URL}/api/verify/urn:uuid:00000000-0000-0000-0000-000000000000`);
        const ms = Date.now() - started;
        expect(res.status !== 401 && res.status !== 403, `needs login (status ${res.status})`);
        expect(res.status < 500, `server error ${res.status} (is PostgreSQL/Redis reachable?)`);
        expect(ms < 2000, `took ${ms} ms`);
        return `${res.status}, ${ms} ms`;
    });

    await check('Rate limit: 429 after the per-minute budget on /api/auth/*', async () => {
        const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
        let last = 0;
        for (let i = 0; i < limit + 5; i++) {
            last = (await fetch(`${BASE_URL}/api/auth/login`, { method: 'POST' })).status;
            if (last === 429) return `blocked at request ${i + 1}`;
        }
        throw new Error(`never hit 429 (last status ${last})`);
    });

    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    console.log('Note: the rate-limit check exhausts your IP budget for ~1 minute.');
    process.exitCode = failed ? 1 : 0;
})();