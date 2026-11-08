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
module.exports = {
    enrolCandidate,
    createPhotoUploadUrl
};