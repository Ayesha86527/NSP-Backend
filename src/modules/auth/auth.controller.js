const crypto = require('crypto');
const authService = require('./auth.service');

// ======================================================
// DEVICE FINGERPRINT EXTRACTOR (FR-AUTH-04)
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
        const deviceCredential = req.headers['x-device-credential'] || null;

        const result = await authService.login(
            email,
            password,
            req.ip,
            deviceFingerprint,
            deviceCredential
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
        const deviceCredential = req.headers['x-device-credential'] || null;

        const result = await authService.verifyMfa(
            email,
            mfaCode,
            req.ip,
            deviceFingerprint,
            deviceCredential
        );

        if (!result.success) {
            return res.status(result.statusCode || 401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

// ======================================================
// START MFA ENROLLMENT
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
        const deviceCredential = req.headers['x-device-credential'] || null;

        const result = await authService.refreshAccessToken(
            refreshToken,
            req.ip,
            deviceFingerprint,
            deviceCredential
        );

        if (!result.success) {
            return res.status(result.statusCode || 401).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        if (error.statusCode === 403) {
            return res.status(403).json({
                success: false,
                message: error.message
            });
        }

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
        const deviceCredential = req.headers['x-device-credential'] || null;

        const result = await authService.verifyBackupCode(
            email,
            password,
            backupCode,
            req.ip,
            deviceFingerprint,
            deviceCredential
        );

        if (!result.success) {
            return res.status(result.statusCode || 401).json(result);
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
// B2: GET PROFILE
// ======================================================
const getProfile = async (req, res, next) => {
    try {
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication is required'
            });
        }

        const profile = await authService.getUserProfile(userId);

        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'User profile not found'
            });
        }

        return res.status(200).json({
            success: true,
            profile
        });
    } catch (error) {
        next(error);
    }
};

// ======================================================
// B2: PATCH PROFILE — PASSWORD ONLY
// ======================================================
const updateProfile = async (req, res, next) => {
    try {
        const userId = req.user?.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication is required'
            });
        }

        const allowedFields = ['currentPassword', 'newPassword'];
        const suppliedFields = Object.keys(req.body || {});

        if (
            suppliedFields.length !== 2 ||
            suppliedFields.some(field => !allowedFields.includes(field))
        ) {
            return res.status(400).json({
                success: false,
                message: 'Only password changes are allowed in the profile'
            });
        }

        const { currentPassword, newPassword } = req.body;

        if (
            typeof currentPassword !== 'string' ||
            typeof newPassword !== 'string' ||
            !currentPassword ||
            !newPassword
        ) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        const passwordByteLength = Buffer.byteLength(newPassword, 'utf8');

        if (passwordByteLength < 12 || passwordByteLength > 72) {
            return res.status(400).json({
                success: false,
                message: 'New password must be between 12 and 72 bytes long'
            });
        }

        const result = await authService.updateUserProfilePassword(
            userId,
            currentPassword,
            newPassword,
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
// B2: LIST OWN SESSIONS
// ======================================================
const getSessions = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        const sessionId = req.user?.sessionId;

        if (!userId || !sessionId) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user session is required'
            });
        }

        const sessions = await authService.getUserSessions(
            userId,
            sessionId
        );

        return res.status(200).json({
            success: true,
            count: sessions.length,
            sessions
        });
    } catch (error) {
        next(error);
    }
};

// ======================================================
// DEVICE HEARTBEAT (EDR STATUS UPDATE)
// ======================================================
async function heartbeat(req, res, next) {
    try {
        const device = await authService.updateDeviceHeartbeat(
            req.device.deviceId,
            req.body.edrStatus
        );

        return res.status(200).json({
            success: true,
            message: 'Device heartbeat received',
            device
        });
    } catch (error) {
        next(error);
    }
}

// ======================================================
// B4: GET CURRENT USER PERMISSIONS
// ======================================================
const getPermissions = async (req, res, next) => {
    try {
        const { userId, role, hubLocationId } = req.user || {};

        if (!userId || !role) {
            return res.status(401).json({
                success: false,
                message: 'Authentication is required'
            });
        }

        const permissionsByRole = {
            TRADE_TESTER: [
                'candidate:create',
                'candidate:read',
                'assessment:create',
                'assessment:update_draft'
            ],

            CENTER_SUPERINTENDENT: [
                'candidate:read',
                'assessment:read',
                'assessment:approve',
                'assessment:reject'
            ],

            SUPER_ADMIN: [
                'system:monitor',
                'users:read',
                'users:create',
                'users:manage',
                'hubs:manage',
                'sessions:manage',
                'audit_logs:read',
                'devices:manage',
                'credentials:revoke'
            ]
        };

        const permissions = permissionsByRole[role];

        if (!permissions) {
            return res.status(403).json({
                success: false,
                message: 'No permissions are configured for this role'
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                userId,
                role,
                hubLocationId: hubLocationId ?? null,
                permissions
            }
        });
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
    stepUp,
    getProfile,
    updateProfile,
    getSessions,
    heartbeat,
    getPermissions
};