const candidateService = require('./candidate.service');

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

module.exports = {
    enrolCandidate
};