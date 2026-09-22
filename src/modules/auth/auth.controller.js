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

        const ipAddress = req.ip;

           const result = await authService.login(
               email,
               password,
               ipAddress
           );

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

        const ipAddress = req.ip;

        const result = await authService.verifyMfa(
            email,
            mfaCode,
            ipAddress
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const refresh = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        const ipAddress = req.ip;

        const result = await authService.refreshAccessToken(
            refreshToken,
            ipAddress
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const revokeSession = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        const ipAddress = req.ip;

        const result = await authService.revokeUserSession(
            req.user.id,
            req.user.email,
            refreshToken,
            ipAddress
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const generateBackupCodes = async (
    req,
    res,
    next
) => {
    try {
        const ipAddress = req.ip;

        const result = await authService.generateBackupCodes(
            req.user.id,
            req.user.email,
            ipAddress
        );

        if (!result.success) {
            return res.status(409).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};


const verifyBackupCode = async (
    req,
    res,
    next
) => {
    try {
        const {
            email,
            backupCode
        } = req.body;

        if (!email || !backupCode) {
            return res.status(400).json({
                success: false,
                message: 'Email and backup code are required'
            });
        }

        const ipAddress = req.ip;

        const result = await authService.verifyBackupCode(
            email,
            backupCode,
            ipAddress
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};


const backupCodeStatus = async (
    req,
    res,
    next
) => {
    try {
        const result =
            await authService.getUserBackupCodeStatus(
                req.user.id
            );

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

module.exports = {
    login,
    verifyMfa,
    refresh,
    revokeSession,
    generateBackupCodes,
    verifyBackupCode,
    backupCodeStatus
};