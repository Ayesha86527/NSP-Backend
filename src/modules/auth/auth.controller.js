const crypto = require('crypto');
const authService = require('./auth.service');

// ======================================================
// DEVICE FINGERPRINT EXTRACTOR (FR-AUTH-04)
// Extracts client fingerprint header (x-device-fingerprint)
// or calculates deterministic SHA-256 fallback from UA + IP.
// ======================================================
const getDeviceFingerprint = (req) => {
    const headerFp = req.headers['x-device-fingerprint'];
    if (headerFp && typeof headerFp === 'string' && headerFp.trim().length > 0) {
        return headerFp.trim().toLowerCase();
    }
    const ua = req.headers['user-agent'] || 'unknown-ua';
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    return crypto.createHash('sha256').update(`${ua}|${ip}`).digest('hex');
};

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

        const deviceFingerprint = getDeviceFingerprint(req);

        const result = await authService.login(
            email,
            password,
            req.ip,
            deviceFingerprint
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
// VERIFY MFA DURING LOGIN
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

        const deviceFingerprint = getDeviceFingerprint(req);

        const result = await authService.verifyMfa(
            email,
            mfaCode,
            req.ip,
            deviceFingerprint
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
// START MFA ENROLLMENT
// Requires a dedicated MFA-enrollment authorization
// middleware, NOT ordinary authenticate middleware.
// ======================================================
const startMfaEnrollment = async (req, res, next) => {
    try {
        const userId = req.user?.userId || req.user?.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Enrollment authorization is required'
            });
        }

        const result = await authService.startMfaEnrollment(
            userId,
            req.ip
        );

        if (!result.success) {
            return res.status(409).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

// ======================================================
// CONFIRM MFA ENROLLMENT
// Requires the same dedicated enrollment middleware.
// ======================================================
const confirmMfaEnrollment = async (req, res, next) => {
    try {
        const userId = req.user?.userId || req.user?.id;
        const { mfaCode } = req.body;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Enrollment authorization is required'
            });
        }

        if (!mfaCode || !/^\d{6}$/.test(String(mfaCode))) {
            return res.status(400).json({
                success: false,
                message: 'A valid six-digit MFA code is required'
            });
        }

        const result = await authService.confirmMfaEnrollment(
            userId,
            String(mfaCode),
            req.ip
        );

        if (!result.success) {
            return res.status(400).json(result);
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

        const deviceFingerprint = getDeviceFingerprint(req);

        const result = await authService.refreshAccessToken(
            refreshToken,
            req.ip,
            deviceFingerprint
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
            refreshToken,
            req.ip
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
// Requires ordinary authenticated access.
// ======================================================
const generateBackupCodes = async (req, res, next) => {
    try {
        const userId = req.user?.userId || req.user?.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication is required'
            });
        }

        const result = await authService.generateBackupCodes(userId);

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
// VERIFY BACKUP CODE DURING LOGIN
// ======================================================
const verifyBackupCode = async (req, res, next) => {
    try {
        const { email, password, backupCode } = req.body;

        if (!email || !password || !backupCode) {
            return res.status(400).json({
                success: false,
                message: 'Email, password, and backup code are required'
            });
        }

        const deviceFingerprint = getDeviceFingerprint(req);

        const result = await authService.verifyBackupCode(
            email,
            password,
            backupCode,
            req.ip,
            deviceFingerprint
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
// Requires ordinary authenticated access.
// ======================================================
const backupCodeStatus = async (req, res, next) => {
    try {
        const userId = req.user?.userId || req.user?.id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication is required'
            });
        }

        const result = await authService.getUserBackupCodeStatus(userId);

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

// ======================================================
// STEP-UP MFA AUTHENTICATION (B1)
// Requires ordinary authenticated access.
// ======================================================
const stepUp = async (req, res, next) => {
    try {
        const { scope, mfaCode, backupCode } = req.body;

        const userId = req.user?.userId;
        const sessionId = req.user?.sessionId;

        if (!userId || !sessionId) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user session is required'
            });
        }

        if (!scope) {
            return res.status(400).json({
                success: false,
                message: 'Step-up scope is required'
            });
        }

        const hasMfaCode =
            typeof mfaCode === 'string' && mfaCode.trim().length > 0;

        const hasBackupCode =
            typeof backupCode === 'string' && backupCode.trim().length > 0;

        if (hasMfaCode === hasBackupCode) {
            return res.status(400).json({
                success: false,
                message: 'Provide exactly one MFA code or backup code'
            });
        }

        const result = await authService.createStepUpToken({
            userId,
            sessionId,
            scope,
            mfaCode,
            backupCode,
            ipAddress: req.ip
        });

        if (!result.success) {
            return res.status(401).json(result);
        }

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
    startMfaEnrollment,
    confirmMfaEnrollment,
    refresh,
    revokeSession,
    generateBackupCodes,
    verifyBackupCode,
    backupCodeStatus,
    stepUp
};