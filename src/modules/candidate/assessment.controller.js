const assessmentService = require('./assessment.service');

const createAssessment = async (req, res, next) => {
    try {
        const {
            candidateId,
            score,
            grade
        } = req.body;

        const assessment =
            await assessmentService.createAssessment({
                candidateId,
                score,
                grade,
                user: req.user
            });

        return res.status(201).json({
            success: true,
            assessment
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

module.exports = {
    createAssessment,
    getAssessment,
    updateAssessment,
    submitAssessment,
    getMyAssessments
};