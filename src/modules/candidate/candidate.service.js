const crypto = require('crypto');

const candidateModel = require('./candidate.model');
const nadraService = require('./nadra/nadra.service');

const generateBlindSalt = () => {
    return crypto.randomBytes(32).toString('hex');
};

const generateSaltedHash = (cnic, blindSalt) => {
    return crypto
        .createHash('sha256')
        .update(`${blindSalt}:${cnic}`)
        .digest('hex');
};

const generateDedupHash = (cnic) => {
    const secret = process.env.CNIC_DEDUP_SECRET;

    if (!secret) {
        throw new Error('CNIC_DEDUP_SECRET is not configured');
    }

    return crypto
        .createHmac('sha256', secret)
        .update(cnic)
        .digest('hex');
};

/**
 * The CNIC is never stored in plain text, only as hashes, so it cannot be
 * returned by the API. Lookups hash the typed CNIC and compare hashes.
 *
 * A CNIC may be typed as 3520212345671 or 35202-1234567-1. Older records
 * were hashed exactly as typed, so lookups and duplicate checks try every
 * common spelling.
 */
const normalizeCnic = (cnic) => {
    const text = String(cnic === undefined || cnic === null ? '' : cnic).trim();
    const digits = text.replace(/\D/g, '');

    if (digits.length === 13) {
        return digits;
    }

    return text;
};

const cnicSpellings = (cnic) => {
    const raw = String(cnic === undefined || cnic === null ? '' : cnic).trim();
    const digits = raw.replace(/\D/g, '');
    const spellings = new Set([raw]);

    if (digits.length === 13) {
        spellings.add(digits);
        spellings.add(
            `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`
        );
    }

    return [...spellings].filter(Boolean);
};

const cnicDedupHashes = (cnic) =>
    cnicSpellings(cnic).map(generateDedupHash);

const enrolCandidate = async ({
    fullName,
    fatherName,
    dob,
    cnic,
    photoS3Uri,
    tradeCategory,
    user
}) => {
    if (!user) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }

    if (
        !['TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPERINTENDENT', 'SUPER_ADMIN']
            .includes(user.role)
    ) {
        const error = new Error('Only authorized hub staff can enrol candidates');
        error.statusCode = 403;
        throw error;
    }

    if (!fullName || !fatherName || !dob || !cnic ||
        !photoS3Uri || !tradeCategory) {
        const error = new Error('Missing required candidate information');
        error.statusCode = 400;
        throw error;
    }

    const nadraResult = await nadraService.verifyIdentity({
        cnic,
        fullName,
        fatherName,
        dob
    });

    if (!nadraResult.verified) {
        const error = new Error('Candidate identity could not be verified');
        error.statusCode = 422;
        throw error;
    }

    const canonicalCnic = normalizeCnic(cnic);

    const blindSalt = generateBlindSalt();

    const saltedHash = generateSaltedHash(
        canonicalCnic,
        blindSalt
    );

    const dedupHash = generateDedupHash(canonicalCnic);

    // Check every spelling so 35202-1234567-1 and 3520212345671
    // are recognised as the same person.
    let existingCandidate = null;

    for (const hash of cnicDedupHashes(cnic)) {
        existingCandidate = await candidateModel.findByDedupHash(hash);

        if (existingCandidate) {
            break;
        }
    }

    if (existingCandidate) {
        const error = new Error('Candidate is already enrolled');
        error.statusCode = 409;
        throw error;
    }

    const candidate = await candidateModel.createCandidate({
        fullName,
        fatherName,
        dob,
        cnicSaltedHash: saltedHash,
        cnicDedupHash: dedupHash,
        cnicBlindSalt: blindSalt,
        photoS3Uri,
        tradeCategory,
        testingHubId: user.hubLocationId || 1
    });

    return candidate;
};

const listCandidatesByHub = async (user) => {
    if (!user) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }

    if (user.role === 'SUPER_ADMIN') {
        const pool = require('../../config/db');
        const res = await pool.query(
            `SELECT candidate_id, full_name, father_name, dob, photo_s3_uri, trade_category, testing_hub_id
             FROM candidate.candidates ORDER BY full_name`
        );
        return res.rows;
    }

    return candidateModel.findByHub(user.hubLocationId || 1);
};

/**
 * Find an enrolled candidate by CNIC.
 * Trade Testers and Superintendents only see their own hub;
 * Super Admins search every hub.
 */
const lookupCandidateByCnic = async ({ cnic, user }) => {
    if (!user) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }

    const digits = String(cnic === undefined || cnic === null ? '' : cnic)
        .replace(/\D/g, '');

    if (digits.length !== 13) {
        const error = new Error('CNIC must contain exactly 13 digits');
        error.statusCode = 400;
        throw error;
    }

    if (user.role === 'SUPER_ADMIN') {
        return candidateModel.findByDedupHashes(cnicDedupHashes(cnic), null);
    }

    return candidateModel.findByDedupHashes(
        cnicDedupHashes(cnic),
        user.hubLocationId
    );
};

module.exports = {
    enrolCandidate,
    listCandidatesByHub,
    lookupCandidateByCnic
};