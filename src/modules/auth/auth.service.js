const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { verify } = require('otplib');
const jwt = require('jsonwebtoken');

const {
    countBackupCodes,
    createBackupCode,
    verifyAndConsumeBackupCode,
    getBackupCodeStatus
} = require('./backupCode.model');

const pool = require('../../config/db');

const {
    createAuditLog
} = require('./audit.model');

const {
    privateKey,
    accessTokenExpiresIn
} = require('../../config/jwt');

const {
    findUserByEmail,
    findUserForMfa,
    findSessionByRefreshTokenHash,
    findUserById,
    revokeSession,
    rotateRefreshToken,
    recordFailedLogin,
    resetFailedLoginAttempts,
    recordFailedMfa,
    resetFailedMfa
} = require('./auth.model');


/*
 * LOGIN
 * Password verification is the first authentication step.
 */
const login = async (email, password, ipAddress) => {
    const user = await findUserByEmail(email);

    if (!user) {
        await createAuditLog({
            userId: null,
            eventType: 'LOGIN_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'User not found'
            }
        });

        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    // Check whether the account is currently locked
    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'LOGIN_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Account is temporarily locked'
            }
        });

        return {
            success: false,
            message: 'Account is temporarily locked'
        };
    }

    const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!passwordMatches) {
        const failedLogin = await recordFailedLogin(
            user.user_id
        );

        await createAuditLog({
            userId: user.user_id,
            eventType: 'LOGIN_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Invalid password',
                failedAttempts: failedLogin
                    ? failedLogin.failed_login_attempts
                    : null
            }
        });

        if (
            failedLogin &&
            failedLogin.failed_login_attempts >= 5
        ) {
            await createAuditLog({
                userId: user.user_id,
                eventType: 'ACCOUNT_LOCKED',
                email: user.email,
                ipAddress,
                details: {
                    reason: '5 consecutive failed login attempts'
                }
            });

            return {
                success: false,
                message: 'Account locked after 5 failed login attempts'
            };
        }

        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    // Successful password login resets the failed-attempt counter
    await resetFailedLoginAttempts(user.user_id);

    if (user.role !== 'TRADE_TESTER') {
        return {
            success: false,
            message: 'Access denied'
        };
    }

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


/*
 * DECRYPT MFA SECRET
 */
const decryptMfaSecret = (encryptedSecret) => {
    const parts = encryptedSecret.split(':');

    if (parts.length !== 3) {
        throw new Error('Invalid encrypted MFA secret format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

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


/*
 * VERIFY MFA
 */
const verifyMfa = async (email, mfaCode, ipAddress) => {
    const user = await findUserForMfa(email);

    if (!user) {
        await createAuditLog({
            userId: null,
            eventType: 'MFA_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'User not found'
            }
        });

        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (!user.is_mfa_active) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'MFA_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA is not active'
            }
        });

        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'MFA_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Account is temporarily locked'
            }
        });

        return {
            success: false,
            message: 'Account is temporarily locked'
        };
    }

    const mfaSecret = decryptMfaSecret(user.mfa_secret);

    const verificationResult = await verify({
        secret: mfaSecret,
        token: mfaCode
    });

    if (!verificationResult.valid) {
        const failedMfa = await recordFailedMfa(
            user.user_id
        );

        await createAuditLog({
            userId: user.user_id,
            eventType: 'MFA_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Invalid MFA code',
                failedAttempts: failedMfa
                    ? failedMfa.failed_mfa_attempts
                    : null
            }
        });

        return {
            success: false,
            message: 'Invalid MFA code'
        };
    }

    await resetFailedMfa(user.user_id);

    await createAuditLog({
        userId: user.user_id,
        eventType: 'MFA_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            method: 'TOTP'
        }
    });

    /*
     * Generate access token
     */
    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn: accessTokenExpiresIn
        }
    );

    /*
     * Generate refresh token
     */
    const refreshToken = crypto
        .randomBytes(64)
        .toString('hex');

    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    /*
     * Store only the refresh-token hash.
     * Device fingerprint is intentionally NULL
     * because fingerprinting was deferred by the team lead.
     */
    await pool.query(
        `
        INSERT INTO auth.sessions (
            user_id,
            refresh_token_hash,
            ip_address,
            device_fingerprint,
            expires_at,
            revoked
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
            user.user_id,
            refreshTokenHash,
            ipAddress,
            null,
            expiresAt,
            false
        ]
    );

    return {
        success: true,
        message: 'Login successful',
        accessToken,
        refreshToken,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role
        }
    };
};


/*
 * REFRESH ACCESS TOKEN
 */
const refreshAccessToken = async (refreshToken, ipAddress) => {
    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const session = await findSessionByRefreshTokenHash(
        refreshTokenHash
    );

    /*
     * Invalid refresh token
     */
    if (!session) {
        await createAuditLog({
            userId: null,
            eventType: 'REFRESH_FAILURE',
            ipAddress,
            details: {
                reason: 'Invalid refresh token'
            }
        });

        return {
            success: false,
            message: 'Invalid refresh token'
        };
    }

    /*
     * Revoked refresh token
     */
    if (session.revoked) {
        const user = await findUserById(session.user_id);

        await createAuditLog({
            userId: session.user_id,
            eventType: 'REFRESH_FAILURE',
            email: user ? user.email : null,
            ipAddress,
            details: {
                reason: 'Refresh token has been revoked'
            }
        });

        return {
            success: false,
            message: 'Refresh token has been revoked'
        };
    }

    /*
     * Expired refresh token
     */
    if (new Date(session.expires_at) <= new Date()) {
        const user = await findUserById(session.user_id);

        await createAuditLog({
            userId: session.user_id,
            eventType: 'REFRESH_FAILURE',
            email: user ? user.email : null,
            ipAddress,
            details: {
                reason: 'Refresh token has expired'
            }
        });

        return {
            success: false,
            message: 'Refresh token has expired'
        };
    }

    const user = await findUserById(session.user_id);

    /*
     * User no longer exists
     */
    if (!user) {
        await createAuditLog({
            userId: session.user_id,
            eventType: 'REFRESH_FAILURE',
            ipAddress,
            details: {
                reason: 'User not found'
            }
        });

        return {
            success: false,
            message: 'User not found'
        };
    }

    /*
     * Role validation
     */
    if (user.role !== 'TRADE_TESTER') {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'REFRESH_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Access denied'
            }
        });

        return {
            success: false,
            message: 'Access denied'
        };
    }

    /*
     * Generate new access token
     */
    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn: accessTokenExpiresIn
        }
    );

    /*
     * Rotate refresh token
     */
    const newRefreshToken = crypto
        .randomBytes(64)
        .toString('hex');

    const newRefreshTokenHash = crypto
        .createHash('sha256')
        .update(newRefreshToken)
        .digest('hex');

    const newExpiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await rotateRefreshToken(
        session.session_id,
        newRefreshTokenHash,
        newExpiresAt,
        ipAddress
    );

    /*
     * Record successful token refresh.
     * The actual token is NEVER written to the audit log.
     */
    await createAuditLog({
        userId: user.user_id,
        eventType: 'TOKEN_REFRESH',
        email: user.email,
        ipAddress,
        details: {
            sessionId: session.session_id,
            refreshTokenRotated: true
        }
    });

    return {
        success: true,
        message: 'Token refreshed successfully',
        accessToken,
        refreshToken: newRefreshToken,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role
        }
    };
};


/*
 * REVOKE USER SESSION
 */
const revokeUserSession = async (
    userId,
    email,
    refreshToken,
    ipAddress
) => {
    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const session = await findSessionByRefreshTokenHash(
        refreshTokenHash
    );

    /*
     * Session not found
     */
    if (!session) {
        await createAuditLog({
            userId,
            eventType: 'SESSION_REVOKE_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'Session not found'
            }
        });

        return {
            success: false,
            message: 'Session not found'
        };
    }

    /*
     * Session belongs to another user
     */
    if (session.user_id !== userId) {
        await createAuditLog({
            userId,
            eventType: 'SESSION_REVOKE_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'Session does not belong to user'
            }
        });

        return {
            success: false,
            message: 'Access denied'
        };
    }

    /*
     * Session is already revoked
     */
    if (session.revoked) {
        await createAuditLog({
            userId,
            eventType: 'SESSION_REVOKE_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'Session already revoked',
                sessionId: session.session_id
            }
        });

        return {
            success: false,
            message: 'Session is already revoked'
        };
    }

    /*
     * Revoke the session
     */
    await revokeSession(session.session_id);

    /*
     * Record successful session revocation
     */
    await createAuditLog({
        userId,
        eventType: 'SESSION_REVOKED',
        email,
        ipAddress,
        details: {
            sessionId: session.session_id
        }
    });

    return {
        success: true,
        message: 'Session revoked successfully'
    };
};

/*
 * GENERATE BACKUP CODES
 *
 * Backup codes are generated only once.
 * If codes already exist, the Trade Tester cannot
 * regenerate them. A future administrative reset
 * process can handle replacement.
 */
const generateBackupCodes = async (
    userId,
    email,
    ipAddress
) => {
    const existingCount = await countBackupCodes(
        userId
    );

    if (existingCount > 0) {
        await createAuditLog({
            userId,
            eventType: 'BACKUP_CODES_GENERATION_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'Backup codes already exist',
                existingCount
            }
        });

        return {
            success: false,
            message: 'Backup codes have already been generated'
        };
    }

    const backupCodes = [];

    for (let i = 0; i < 10; i++) {
        const backupCode = crypto
            .randomBytes(8)
            .toString('hex')
            .toUpperCase();

        const codeHash = await bcrypt.hash(
            backupCode,
            12
        );

        await createBackupCode(
            userId,
            codeHash
        );

        backupCodes.push(backupCode);
    }

    await createAuditLog({
        userId,
        eventType: 'BACKUP_CODES_GENERATED',
        email,
        ipAddress,
        details: {
            count: 10
        }
    });

    return {
        success: true,
        message: 'Backup codes generated successfully',
        backupCodes
    };
};


/*
 * VERIFY BACKUP CODE
 *
 * This is an alternative second factor after
 * successful password verification.
 */
const verifyBackupCode = async (
    email,
    backupCode,
    ipAddress
) => {
    const user = await findUserForMfa(email);

    if (!user) {
        await createAuditLog({
            userId: null,
            eventType: 'BACKUP_CODE_FAILURE',
            email,
            ipAddress,
            details: {
                reason: 'User not found'
            }
        });

        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (!user.is_mfa_active) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'BACKUP_CODE_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'MFA is not active'
            }
        });

        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'BACKUP_CODE_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Account is temporarily locked'
            }
        });

        return {
            success: false,
            message: 'Account is temporarily locked'
        };
    }

    const result = await verifyAndConsumeBackupCode(
        user.user_id,
        backupCode
    );

    if (!result.success) {
        await createAuditLog({
            userId: user.user_id,
            eventType: 'BACKUP_CODE_FAILURE',
            email: user.email,
            ipAddress,
            details: {
                reason: 'Invalid or already used backup code'
            }
        });

        return {
            success: false,
            message: 'Invalid or already used backup code'
        };
    }

    await createAuditLog({
        userId: user.user_id,
        eventType: 'BACKUP_CODE_SUCCESS',
        email: user.email,
        ipAddress,
        details: {
            backupCodeId: result.backupCodeId
        }
    });

    /*
     * Generate access token
     */
    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role
        },
        privateKey,
        {
            algorithm: 'RS256',
            expiresIn: accessTokenExpiresIn
        }
    );

    /*
     * Generate refresh token
     */
    const refreshToken = crypto
        .randomBytes(64)
        .toString('hex');

    const refreshTokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

    const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await pool.query(
        `
        INSERT INTO auth.sessions (
            user_id,
            refresh_token_hash,
            ip_address,
            device_fingerprint,
            expires_at,
            revoked
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
            user.user_id,
            refreshTokenHash,
            ipAddress,
            null,
            expiresAt,
            false
        ]
    );

    return {
        success: true,
        message: 'Login successful using backup code',
        accessToken,
        refreshToken,
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role
        }
    };
};


/*
 * BACKUP CODE STATUS
 */
const getUserBackupCodeStatus = async (
    userId
) => {
    const status = await getBackupCodeStatus(
        userId
    );

    return {
        success: true,
        totalCodes: Number(status.total_codes),
        unusedCodes: Number(status.unused_codes),
        usedCodes: Number(status.used_codes)
    };
};

module.exports = {
    login,
    verifyMfa,
    refreshAccessToken,
    revokeUserSession,
    generateBackupCodes,
    verifyBackupCode,
    getUserBackupCodeStatus
};