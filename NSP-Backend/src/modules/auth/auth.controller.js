const authService = require('./auth.service');

const login = (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: 'Email and password are required'
        });
    }

    const result = authService.login(email, password);

    if (!result.success) {
        return res.status(401).json(result);
    }

    return res.status(200).json(result);
};

const verifyMfa = (req, res) => {
    const { email, mfaCode } = req.body;

    if (!email || !mfaCode) {
        return res.status(400).json({
            success: false,
            message: 'Email and MFA code are required'
        });
    }

    const result = authService.verifyMfa(email, mfaCode);

    if (!result.success) {
        return res.status(401).json(result);
    }

    return res.status(200).json(result);
};

module.exports = {
    login,
    verifyMfa
};