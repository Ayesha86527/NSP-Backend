const authService = require('./auth.service');

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const result = await authService.login(email, password);

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const verifyMfa = async (req, res, next) => {
    try {
        const { email, mfaCode } = req.body;

        if (!email || !mfaCode) {
            return res.status(400).json({
                success: false,
                message: 'Email and MFA code are required'
            });
        }

        const result = await authService.verifyMfa(
            email,
            mfaCode
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    login,
    verifyMfa
};