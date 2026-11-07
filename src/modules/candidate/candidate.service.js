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

    if (user.role !== 'TRADE_TESTER') {
        const error = new Error('Only Trade Testers can enrol candidates');
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

    const blindSalt = generateBlindSalt();

    const saltedHash = generateSaltedHash(
        cnic,
        blindSalt
    );

    const dedupHash = generateDedupHash(cnic);

    const existingCandidate =
        await candidateModel.findByDedupHash(dedupHash);

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
        testingHubId: user.hubLocationId
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

    return candidateModel.findByHub(user.hubLocationId);
};

module.exports = {
    enrolCandidate,
    listCandidatesByHub
};