const authService = require('./auth.service');


// ======================================================
// LOGIN
// ======================================================

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


// ======================================================
// VERIFY MFA
// ======================================================

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


// ======================================================
// REFRESH ACCESS TOKEN
// ======================================================

const refresh = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        const result = await authService.refreshAccessToken(
            refreshToken
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};


// ======================================================
// REVOKE SESSION
// ======================================================

const revokeSession = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required'
            });
        }

        const result = await authService.revokeUserSession(
            refreshToken
        );

        if (!result.success) {
            return res.status(401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};


// ======================================================
// GENERATE BACKUP CODES
// ======================================================

const generateBackupCodes = async (req, res, next) => {
    try {
        const result = await authService.generateBackupCodes(
            req.user.id
        );

        if (!result.success) {
            return res.status(409).json(result);
        }

        // Plaintext backup codes are returned only at generation.
        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};


// ======================================================
// VERIFY BACKUP CODE
// Requires email, password, and backupCode.
// ======================================================

const verifyBackupCode = async (req, res, next) => {
    try {
        const {
            email,
            password,
            backupCode
        } = req.body;

        if (!email || !password || !backupCode) {
            return res.status(400).json({
                success: false,
                message:
                    'Email, password, and backup code are required'
            });
        }

        const ipAddress = req.ip;

        const result = await authService.verifyBackupCode(
            email,
            password,
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


// ======================================================
// BACKUP-CODE STATUS
// ======================================================

const backupCodeStatus = async (req, res, next) => {
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


// ======================================================
// EXPORT CONTROLLERS
// ======================================================

module.exports = {
    login,
    verifyMfa,
    refresh,
    revokeSession,
    generateBackupCodes,
    verifyBackupCode,
    backupCodeStatus
};
