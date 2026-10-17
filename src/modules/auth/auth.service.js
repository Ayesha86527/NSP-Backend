
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify } = require('otplib');

const { createAuditLog } = require('./audit.model');

const {
    findUserByEmail,
    findUserForMfa,
    findSessionByRefreshTokenHash,
    findUserById,
    revokeSession,
    rotateRefreshToken,
    recordFailedLogin,
    resetFailedLoginAttempts
} = require('./auth.model');

const {
    generateBackupCodesIfAbsent,
    verifyAndConsumeBackupCode,
    getBackupCodeStatus
} = require('./backupCode.model');

const {
    privateKey,
    accessTokenExpiresIn
} = require('../../config/jwt');

const pool = require('../../config/db');

// ======================================================
// SAFE AUDIT LOGGING
// Audit failures must not interrupt authentication.
// Never include passwords, MFA codes, or raw tokens.
// ======================================================

const logAuditSafely = async ({
    userId = null,
    eventType,
    email = null,
    ipAddress = null,
    details = null
}) => {
    try {
        await createAuditLog({
            userId,
            eventType,
            email,
            ipAddress,
            details
        });
    } catch (error) {
        console.error(
            '[AUDIT] Failed to write audit log:',
            error.message
        );
    }
};

const getAllowedAuthRole = (role) =>
    role === 'TRADE_TESTER' ||
    role === 'CENTER_SUPERINTENDENT';

const getUserAuditDetails = (user) => ({
    role: user.role
});

// ======================================================
// LOGIN: EMAIL + PASSWORD + ACCOUNT LOCKOUT
// ======================================================

const login = async (email, password, ipAddress = null) => {
    const user = await findUserByEmail(email);

    if (!user) {
        await logAuditSafely({
            eventType: 'AUTH_LOGIN_FAILED',
            email,
            ipAddress,
            details: {
                reason: 'USER_NOT_FOUND',
                method: 'PASSWORD'
            }
        });

        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_LOGIN_BLOCKED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ACCOUNT_LOCKED',
                method: 'PASSWORD'
            }
        });

        return {
            success: false,
            message: 'Account locked. Please try again later.'
        };
    }

    const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!passwordMatches) {
        const failedLogin = await recordFailedLogin(user.user_id);

        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_LOGIN_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'INVALID_PASSWORD',
                method: 'PASSWORD'
            }
        });

        if (
            failedLogin &&
            failedLogin.failed_login_attempts >= 5
        ) {
            await logAuditSafely({
                userId: user.user_id,
                eventType: 'AUTH_ACCOUNT_LOCKED',
                email: user.email,
                ipAddress,
                details: {
                    reason: 'FAILED_LOGIN_LIMIT_REACHED'
                }
            });

            return {
                success: false,
                message:
                    'Account locked for 15 minutes due to too many failed login attempts.'
            };
        }

        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

<<<<<<< HEAD
    /*
     * Both Trade Testers and Center Superintendents
     * are allowed to use the portal.
     */
    if (
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT' &&
        user.role !== 'SUPER_ADMIN'
    ) {
=======
    if (!getAllowedAuthRole(user.role)) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_LOGIN_DENIED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ROLE_NOT_ALLOWED',
                method: 'PASSWORD'
            }
        });

>>>>>>> 375fda34684a4301648a693eda65b3b00190d006
        return {
            success: false,
            message: 'Access denied'
        };
    }

    await resetFailedLoginAttempts(user.user_id);

    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_PASSWORD_VERIFIED',
        email: user.email,
        ipAddress,
        details: {
            nextStep: 'MFA_REQUIRED'
        }
    });

    // Explicitly record that the password step passed and an MFA
    // challenge is now required. Do not log the MFA code or secret.
    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_MFA_CHALLENGE_ISSUED',
        email: user.email,
        ipAddress,
        details: {
            challengeType: 'TOTP',
            result: 'CHALLENGE_REQUIRED'
        }
    });

    return {
        success: true,
        message: 'Password verified. MFA verification required.',
        mfaRequired: true,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        }
    };
};

// ======================================================
// DECRYPT ENCRYPTED MFA SECRET
// ======================================================

const decryptMfaSecret = (encryptedSecret) => {
    if (!encryptedSecret) {
        throw new Error('MFA secret is missing');
    }

    const parts = encryptedSecret.split(':');

    if (parts.length !== 3) {
        throw new Error('Invalid encrypted MFA secret format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    if (!process.env.MFA_ENCRYPTION_KEY) {
        throw new Error('MFA_ENCRYPTION_KEY is not configured');
    }

    const key = Buffer.from(
        process.env.MFA_ENCRYPTION_KEY,
        'hex'
    );

    if (key.length !== 32) {
        throw new Error(
            'MFA_ENCRYPTION_KEY must be exactly 32 bytes'
        );
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        iv
    );

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(
        encrypted,
        undefined,
        'utf8'
    );

    decrypted += decipher.final('utf8');

    return decrypted;
};

// ======================================================
// VERIFY MFA + CREATE SESSION
// ======================================================

const verifyMfa = async (email, mfaCode, ipAddress = null) => {
    const user = await findUserForMfa(email);

    if (!user) {
        await logAuditSafely({
            eventType: 'AUTH_MFA_FAILED',
            email,
            ipAddress,
            details: {
                reason: 'USER_NOT_FOUND',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (
<<<<<<< HEAD
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT' &&
        user.role !== 'SUPER_ADMIN'
    ) {
        return { success: false, message: 'Access denied' };
=======
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_BLOCKED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ACCOUNT_LOCKED',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'Account locked. Please try again later.'
        };
    }

    if (!getAllowedAuthRole(user.role)) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_DENIED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ROLE_NOT_ALLOWED'
            }
        });

        return {
            success: false,
            message: 'Access denied'
        };
>>>>>>> 375fda34684a4301648a693eda65b3b00190d006
    }

    if (!user.is_mfa_active) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA_NOT_ACTIVE',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    let mfaSecret;

    try {
        mfaSecret = decryptMfaSecret(user.mfa_secret);
    } catch (error) {
        console.error('[AUTH] MFA secret decryption failed.');

        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA_SECRET_DECRYPTION_FAILED',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'Unable to verify MFA'
        };
    }

    let result;

    try {
        result = await verify({
            secret: mfaSecret,
            token: mfaCode
        });
    } catch (error) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA_VERIFICATION_ERROR',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'Unable to verify MFA'
        };
    }

    if (!result.valid) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_MFA_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'INVALID_MFA_CODE',
                method: 'TOTP'
            }
        });

        return {
            success: false,
            message: 'Invalid MFA code'
        };
    }

    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn: accessTokenExpiresIn
        }
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');

    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await pool.query(
        `INSERT INTO auth.sessions
            (user_id, refresh_token_hash, ip_address, expires_at, revoked)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [
            user.user_id,
            refreshTokenHash,
            ipAddress || '127.0.0.1',
            expiresAt
        ]
    );

    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_MFA_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            method: 'TOTP',
            result: 'SUCCESS'
        }
    });

    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_LOGIN_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            method: 'MFA'
        }
    });

    return {
        success: true,
        message: 'Login successful',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: accessTokenExpiresIn,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        }
    };
};

// ======================================================
// GENERATE BACKUP CODES
// Creates 10 codes only when no codes already exist.
// ======================================================

const generateBackupCodes = async (userId) => {
    const backupCodes = [];
    const codeHashes = [];

    for (let i = 0; i < 10; i++) {
        const backupCode = crypto.randomBytes(8).toString('hex');
        const codeHash = await bcrypt.hash(backupCode, 12);

        backupCodes.push(backupCode);
        codeHashes.push(codeHash);
    }

    const result = await generateBackupCodesIfAbsent(
        userId,
        codeHashes
    );

    if (!result.created) {
        if (result.reason === 'user_not_found') {
            await logAuditSafely({
                userId,
                eventType: 'AUTH_BACKUP_CODES_GENERATION_FAILED',
                details: {
                    reason: 'USER_NOT_FOUND'
                }
            });

            return {
                success: false,
                message: 'User not found'
            };
        }

        await logAuditSafely({
            userId,
            eventType: 'AUTH_BACKUP_CODES_GENERATION_FAILED',
            details: {
                reason: 'BACKUP_CODES_ALREADY_EXIST'
            }
        });

        return {
            success: false,
            message:
                'Backup codes already exist. Use your existing codes.'
        };
    }

    await logAuditSafely({
        userId,
        eventType: 'AUTH_BACKUP_CODES_GENERATED',
        details: {
            count: backupCodes.length
        }
    });

    return {
        success: true,
        message:
            'Backup codes generated. Save them now; they will not be shown again.',
        backupCodes
    };
};

// ======================================================
// VERIFY AND CONSUME A BACKUP CODE
// Requires email + password + backup code.
// ======================================================

const verifyBackupCode = async (
    email,
    password,
    backupCode,
    ipAddress = null
) => {
    const user = await findUserByEmail(email);

    if (!user) {
        await logAuditSafely({
            eventType: 'AUTH_BACKUP_CODE_LOGIN_FAILED',
            email,
            ipAddress,
            details: {
                reason: 'USER_NOT_FOUND'
            }
        });

        return {
            success: false,
            message: 'Invalid credentials or backup code'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_BACKUP_CODE_LOGIN_BLOCKED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ACCOUNT_LOCKED'
            }
        });

        return {
            success: false,
            message: 'Account locked. Please try again later.'
        };
    }

    const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!passwordMatches) {
        const failedLogin = await recordFailedLogin(user.user_id);

        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_BACKUP_CODE_LOGIN_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'INVALID_PASSWORD'
            }
        });

        if (
            failedLogin &&
            failedLogin.failed_login_attempts >= 5
        ) {
            await logAuditSafely({
                userId: user.user_id,
                eventType: 'AUTH_ACCOUNT_LOCKED',
                email: user.email,
                ipAddress,
                details: {
                    reason: 'FAILED_LOGIN_LIMIT_REACHED'
                }
            });

            return {
                success: false,
                message:
                    'Account locked for 15 minutes due to too many failed login attempts.'
            };
        }

        return {
            success: false,
            message: 'Invalid credentials or backup code'
        };
    }

    if (!getAllowedAuthRole(user.role)) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_BACKUP_CODE_LOGIN_DENIED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'ROLE_NOT_ALLOWED'
            }
        });

        return {
            success: false,
            message: 'Access denied'
        };
    }

    if (!user.is_mfa_active) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_BACKUP_CODE_LOGIN_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA_NOT_ACTIVE'
            }
        });

        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    const verification = await verifyAndConsumeBackupCode(
        user.user_id,
        backupCode
    );

    if (!verification.success) {
        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_BACKUP_CODE_LOGIN_FAILED',
            email: user.email,
            ipAddress,
            details: {
                reason: 'INVALID_OR_USED_BACKUP_CODE'
            }
        });

        return {
            success: false,
            message: 'Invalid or already-used backup code'
        };
    }

    await resetFailedLoginAttempts(user.user_id);

    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn: accessTokenExpiresIn
        }
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');

    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await pool.query(
        `INSERT INTO auth.sessions
            (user_id, refresh_token_hash, ip_address, expires_at, revoked)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [
            user.user_id,
            refreshTokenHash,
            ipAddress || '127.0.0.1',
            expiresAt
        ]
    );

    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_MFA_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            method: 'BACKUP_CODE',
            result: 'SUCCESS'
        }
    });

    await logAuditSafely({
        userId: user.user_id,
        eventType: 'AUTH_LOGIN_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            method: 'BACKUP_CODE'
        }
    });

    return {
        success: true,
        message: 'Backup code verified. Login successful.',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresIn: accessTokenExpiresIn,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        }
    };
};

// ======================================================
// GET BACKUP-CODE STATUS
// ======================================================

const getUserBackupCodeStatus = async (userId) => {
    const status = await getBackupCodeStatus(userId);

    return {
        success: true,
        totalCodes: status.total_codes,
        unusedCodes: status.unused_codes,
        usedCodes: status.used_codes
    };
};

// ======================================================
// REFRESH ACCESS TOKEN + ROTATE REFRESH TOKEN
// ======================================================

const refreshAccessToken = async (
    refreshToken,
    ipAddress = null
) => {
    let auditUser = null;

    try {
        if (
            typeof refreshToken !== 'string' ||
            refreshToken.length === 0
        ) {
            throw new Error('Invalid refresh token');
        }

        const refreshTokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        const session = await findSessionByRefreshTokenHash(
            refreshTokenHash
        );

        if (
            !session ||
            session.revoked ||
            new Date(session.expires_at) <= new Date()
        ) {
            throw new Error('Invalid or expired refresh token');
        }

        const user = await findUserById(session.user_id);

        if (!user) {
            throw new Error('Invalid or expired refresh token');
        }

        auditUser = user;

        // Generate a new refresh token; only its hash is stored.
        const newRefreshToken = crypto
            .randomBytes(40)
            .toString('hex');

        const newRefreshTokenHash = crypto
            .createHash('sha256')
            .update(newRefreshToken)
            .digest('hex');

        const newExpiresAt = new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000
        );

        const rotatedSession = await rotateRefreshToken(
            session.session_id,
            refreshTokenHash,
            newRefreshTokenHash,
            newExpiresAt,
            ipAddress || session.ip_address || '127.0.0.1'
        );

        if (!rotatedSession) {
            throw new Error('Refresh token rotation failed');
        }

        const accessToken = jwt.sign(
            {
                sub: user.user_id,
                email: user.email,
                role: user.role,
                hubLocationId: user.hub_location_id
            },
            privateKey,
            {
                algorithm: 'RS256',
                expiresIn: accessTokenExpiresIn
            }
        );

        await logAuditSafely({
            userId: user.user_id,
            eventType: 'AUTH_TOKEN_REFRESHED',
            email: user.email,
            ipAddress,
            details: {
                result: 'SUCCESS'
            }
        });

        return {
            success: true,
            message: 'Access token refreshed successfully',
            accessToken,
            refreshToken: newRefreshToken,
            tokenType: 'Bearer',
            expiresIn: accessTokenExpiresIn
        };
    } catch (error) {
        await logAuditSafely({
            userId: auditUser ? auditUser.user_id : null,
            eventType: 'AUTH_TOKEN_REFRESH_FAILED',
            email: auditUser ? auditUser.email : null,
            ipAddress,
            details: {
                reason: 'INVALID_OR_EXPIRED_REFRESH_TOKEN'
            }
        });

        throw new Error('Invalid or expired refresh token');
    }
};

// ======================================================
// REVOKE SESSION
// ======================================================

const revokeUserSession = async (
    refreshToken,
    ipAddress = null
) => {
    try {
        if (
            typeof refreshToken !== 'string' ||
            refreshToken.length === 0
        ) {
            await logAuditSafely({
                eventType: 'AUTH_SESSION_REVOCATION_FAILED',
                ipAddress,
                details: {
                    reason: 'MISSING_REFRESH_TOKEN'
                }
            });

            return {
                success: false,
                message: 'Failed to revoke session'
            };
        }

        const refreshTokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        const session = await findSessionByRefreshTokenHash(
            refreshTokenHash
        );

        if (!session) {
            // Keep the external response generic to avoid revealing
            // whether a particular refresh token exists.
            await logAuditSafely({
                eventType: 'AUTH_SESSION_REVOCATION_FAILED',
                ipAddress,
                details: {
                    reason: 'SESSION_NOT_FOUND_OR_INVALID'
                }
            });

            return {
                success: true,
                message: 'Session revoked successfully. Token invalidated.'
            };
        }

        if (session.revoked) {
            await logAuditSafely({
                userId: session.user_id,
                eventType: 'AUTH_SESSION_REVOCATION_FAILED',
                ipAddress,
                details: {
                    reason: 'SESSION_ALREADY_REVOKED'
                }
            });

            return {
                success: true,
                message: 'Session revoked successfully. Token invalidated.'
            };
        }

        await revokeSession(session.session_id);

        const user = await findUserById(session.user_id);

        await logAuditSafely({
            userId: session.user_id,
            eventType: 'AUTH_SESSION_REVOKED',
            email: user ? user.email : null,
            ipAddress,
            details: {
                result: 'SUCCESS'
            }
        });

        return {
            success: true,
            message: 'Session revoked successfully. Token invalidated.'
        };
    } catch (error) {
        await logAuditSafely({
            eventType: 'AUTH_SESSION_REVOCATION_FAILED',
            ipAddress,
            details: {
                reason: 'REVOCATION_OPERATION_FAILED'
            }
        });

        console.error(
            '[AUTH] Session revocation failed:',
            error.message
        );

        return {
            success: false,
            message: 'Failed to revoke session'
        };
    }
};

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
    login,
    verifyMfa,
    generateBackupCodes,
    verifyBackupCode,
    getUserBackupCodeStatus,
    refreshAccessToken,
    revokeUserSession
};
