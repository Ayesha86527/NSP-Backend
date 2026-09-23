const assessmentModel = require('./assessment.model');
const candidateModel = require('./candidate.model');

const validateTester = (user) => {
    if (!user) {
        const error = new Error('Authentication required');
        error.statusCode = 401;
        throw error;
    }

    if (user.role !== 'TRADE_TESTER') {
        const error = new Error(
            'Only Trade Testers can manage assessments'
        );
        error.statusCode = 403;
        throw error;
    }
};

const validateAssessmentInput = ({
    score,
    grade
}) => {
    if (score === undefined || score === null || grade === undefined || !grade) {
        const error = new Error(
            'Score and grade are required'
        );
        error.statusCode = 400;
        throw error;
    }
};

const createAssessment = async ({
    candidateId,
    score,
    grade,
    user
}) => {
    validateTester(user);

    validateAssessmentInput({
        score,
        grade
    });

    const candidate = await candidateModel.findById(candidateId);

    if (!candidate) {
        const error = new Error('Candidate not found');
        error.statusCode = 404;
        throw error;
    }

    if (candidate.testing_hub_id !== user.hubLocationId) {
        const error = new Error(
            'Candidate does not belong to your testing hub'
        );
        error.statusCode = 403;
        throw error;
    }

    const assessment = await assessmentModel.createAssessment({
        candidateId,
        score,
        grade,
        testerUserId: user.userId
    });

    return assessment;
};

const getAssessment = async ({
    assessmentId,
    user
}) => {
    validateTester(user);

    const assessment = await assessmentModel.findById(
        assessmentId
    );

    if (!assessment) {
        const error = new Error('Assessment not found');
        error.statusCode = 404;
        throw error;
    }

    if (assessment.tester_user_id !== user.userId) {
        const candidate = await candidateModel.findById(
            assessment.candidate_id
        );

        if (!candidate) {
            const error = new Error('Candidate not found');
            error.statusCode = 404;
            throw error;
        }

        if (candidate.testing_hub_id !== user.hubLocationId) {
            const error = new Error('Access denied');
            error.statusCode = 403;
            throw error;
        }
    }

    return assessment;
};

const updateAssessment = async ({
    assessmentId,
    score,
    grade,
    user
}) => {
    validateTester(user);

    validateAssessmentInput({
        score,
        grade
    });

    const assessment = await assessmentModel.findById(
        assessmentId
    );

    if (!assessment) {
        const error = new Error('Assessment not found');
        error.statusCode = 404;
        throw error;
    }

    if (assessment.tester_user_id !== user.userId) {
        const error = new Error(
            'You can only update your own assessments'
        );
        error.statusCode = 403;
        throw error;
    }

    if (assessment.status !== 'DRAFT') {
        const error = new Error(
            'Only DRAFT assessments can be updated'
        );
        error.statusCode = 409;
        throw error;
    }

    const updatedAssessment =
        await assessmentModel.updateDraft({
            assessmentId,
            score,
            grade,
            testerUserId: user.userId
        });

    if (!updatedAssessment) {
        const error = new Error(
            'Assessment could not be updated'
        );
        error.statusCode = 409;
        throw error;
    }

    return updatedAssessment;
};

const submitAssessment = async ({
    assessmentId,
    user
}) => {
    validateTester(user);

    const assessment = await assessmentModel.findById(
        assessmentId
    );

    if (!assessment) {
        const error = new Error('Assessment not found');
        error.statusCode = 404;
        throw error;
    }

    if (assessment.tester_user_id !== user.userId) {
        const error = new Error(
            'You can only submit your own assessments'
        );
        error.statusCode = 403;
        throw error;
    }

    if (assessment.status !== 'DRAFT') {
        const error = new Error(
            'Only DRAFT assessments can be submitted'
        );
        error.statusCode = 409;
        throw error;
    }

    const submittedAssessment =
        await assessmentModel.submitDraft({
            assessmentId,
            testerUserId: user.userId
        });

    if (!submittedAssessment) {
        const error = new Error(
            'Assessment could not be submitted'
        );
        error.statusCode = 409;
        throw error;
    }

    return submittedAssessment;
};

const getMyAssessments = async ({
    user
}) => {
    validateTester(user);

    return assessmentModel.findByTester(
        user.userId
    );
};

module.exports = {
    createAssessment,
    getAssessment,
    updateAssessment,
    submitAssessment,
    getMyAssessments
};