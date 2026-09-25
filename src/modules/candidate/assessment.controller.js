const assessmentService = require('./assessment.service');

const createAssessment = async (req, res, next) => {
    try {
        const {
            candidateId,
            score,
            grade,
            clientRequestId
        } = req.body;

        const result =
            await assessmentService.createAssessment({
                candidateId,
                score,
                grade,
                clientRequestId,
                user: req.user
            });
        return res.status(
            result.replayed ? 200 : 201
        ).json({
            success: true,
            replayed: result.replayed,
            assessment: result.assessment
        });
    } catch (error) {
        next(error);
    }
};

const getAssessment = async (req, res, next) => {
    try {
        const {
            assessmentId
        } = req.params;

        const assessment =
            await assessmentService.getAssessment({
                assessmentId,
                user: req.user
            });

        return res.status(200).json({
            success: true,
            assessment
        });
    } catch (error) {
        next(error);
    }
};

const updateAssessment = async (req, res, next) => {
    try {
        const {
            assessmentId
        } = req.params;

        const {
            score,
            grade
        } = req.body;

        const assessment =
            await assessmentService.updateAssessment({
                assessmentId,
                score,
                grade,
                user: req.user
            });

        return res.status(200).json({
            success: true,
            assessment
        });
    } catch (error) {
        next(error);
    }
};

const submitAssessment = async (req, res, next) => {
    try {
        const {
            assessmentId
        } = req.params;

        const assessment =
            await assessmentService.submitAssessment({
                assessmentId,
                user: req.user
            });

        return res.status(200).json({
            success: true,
            assessment
        });
    } catch (error) {
        next(error);
    }
};

const getMyAssessments = async (req, res, next) => {
    try {
        const assessments =
            await assessmentService.getMyAssessments({
                user: req.user
            });

        return res.status(200).json({
            success: true,
            assessments
        });
    } catch (error) {
        next(error);
    }
};
//assessment media :
const createAssessmentPhotoUploadUrl =
    async (req, res, next) => {
        try {
            const {
                assessmentId
            } = req.params;

            const result =
                await assessmentService
                    .createAssessmentPhotoUploadUrl({
                        assessmentId,
                        user: req.user
                    });

            return res.status(200).json({
                success: true,
                ...result
            });
        } catch (error) {
            next(error);
        }
    };
const addAssessmentMedia = async (req, res, next) => {
    try {
        const {
            assessmentId
        } = req.params;

        const {
            mediaS3Uri
        } = req.body;

        const media =
            await assessmentService.addAssessmentMedia({
                assessmentId,
                mediaS3Uri,
                user: req.user
            });

        return res.status(201).json({
            success: true,
            media
        });
    } catch (error) {
        next(error);
    }
};
const getAssessmentMedia = async (req, res, next) => {
    try {
        const {
            assessmentId
        } = req.params;

        const media =
            await assessmentService.getAssessmentMedia({
                assessmentId,
                user: req.user
            });

        return res.status(200).json({
            success: true,
            media
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    createAssessment,
    getAssessment,
    updateAssessment,
    submitAssessment,
    getMyAssessments,
    createAssessmentPhotoUploadUrl,
    addAssessmentMedia,
    getAssessmentMedia
};