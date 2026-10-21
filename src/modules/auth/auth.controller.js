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
        const { email, password, backupCode } = req.body;

        if (!email || !password || !backupCode) {
            return res.status(400).json({
                success: false,
                message:
                    'Email, password, and backup code are required'
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
