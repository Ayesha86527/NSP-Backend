const candidateService = require('./candidate.service');
const s3Service = require('./s3.service');

const enrolCandidate = async (req, res, next) => {
    try {
        const candidate = await candidateService.enrolCandidate({
            ...req.body,
            user: req.user
        });

        return res.status(201).json({
            success: true,
            candidate
        });
    } catch (error) {
        next(error);
    }
};

const createPhotoUploadUrl = async (req, res, next) => {
    try {
        const body = req.body || {};

        const result = await s3Service.createPhotoUploadUrl({
            userId: req.user.userId,
            // Accept the common field names a frontend might use.
            contentType:
                body.contentType || body.fileType || body.mimeType
        });

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

const lookupCandidate = async (req, res, next) => {
    try {
        const body = req.body || {};

        const candidates = await candidateService.lookupCandidateByCnic({
            cnic: body.cnic,
            user: req.user
        });

        return res.status(200).json({
            success: true,
            found: candidates.length > 0,
            candidates
        });
    } catch (error) {
        next(error);
    }
};

const listCandidates = async (req, res, next) => {
    try {
        // GET /api/candidates?cnic=3520212345671 -> CNIC lookup.
        // (POST /api/candidates/lookup is preferred: it keeps the CNIC
        // out of URLs and access logs.)
        if (req.query && req.query.cnic) {
            const matches = await candidateService.lookupCandidateByCnic({
                cnic: req.query.cnic,
                user: req.user
            });

            return res.status(200).json({
                success: true,
                found: matches.length > 0,
                candidates: matches
            });
        }

        const candidates = await candidateService.listCandidatesByHub(req.user);
        return res.status(200).json({
            success: true,
            candidates
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    enrolCandidate,
    createPhotoUploadUrl,
    listCandidates,
    lookupCandidate
};