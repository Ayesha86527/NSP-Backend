
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify } = require('otplib');

const {
    findUserByEmail,
    findUserForMfa,
    findSessionByRefreshTokenHash,
    findUserById,
    revokeSession,
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
// LOGIN: EMAIL + PASSWORD + ACCOUNT LOCKOUT
// ======================================================

const login = async (email, password) => {
    const user = await findUserByEmail(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
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

        if (
            failedLogin &&
            failedLogin.failed_login_attempts >= 5
        ) {
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

    if (
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT'
    ) {
        return {
            success: false,
            message: 'Access denied'
        };
    }

    await resetFailedLoginAttempts(user.user_id);

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

const verifyMfa = async (email, mfaCode, ipAddress) => {
    const user = await findUserForMfa(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
        return {
            success: false,
            message: 'Account locked. Please try again later.'
        };
    }

    if (
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT'
    ) {
        return {
            success: false,
            message: 'Access denied'
        };
    }

    if (!user.is_mfa_active) {
        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    let mfaSecret;

    try {
        mfaSecret = decryptMfaSecret(user.mfa_secret);
    } catch (error) {
        console.error('MFA secret decryption failed');

        return {
            success: false,
            message: 'Unable to verify MFA'
        };
    }

    const result = await verify({
        secret: mfaSecret,
        token: mfaCode
    });

    if (!result.valid) {
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
// Plaintext codes are returned only after successful creation.
// ======================================================

const generateBackupCodes = async (userId) => {
    const backupCodes = [];
    const codeHashes = [];

    // Generate and hash all 10 codes before writing to the database.
    for (let i = 0; i < 10; i++) {
        const backupCode = crypto.randomBytes(8).toString('hex');
        const codeHash = await bcrypt.hash(backupCode, 12);

        backupCodes.push(backupCode);
        codeHashes.push(codeHash);
    }

    // The model checks and inserts within a database transaction.
    const result = await generateBackupCodesIfAbsent(
        userId,
        codeHashes
    );

    if (!result.created) {
        if (result.reason === 'user_not_found') {
            return {
                success: false,
                message: 'User not found'
            };
        }

        return {
            success: false,
            message:
                'Backup codes already exist. Use your existing codes.'
        };
    }

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
    ipAddress
) => {
    const user = await findUserByEmail(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid credentials or backup code'
        };
    }

    if (
        user.locked_until &&
        new Date(user.locked_until) > new Date()
    ) {
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

        if (
            failedLogin &&
            failedLogin.failed_login_attempts >= 5
        ) {
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

    if (
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT'
    ) {
        return {
            success: false,
            message: 'Access denied'
        };
    }

    if (!user.is_mfa_active) {
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
// REFRESH ACCESS TOKEN
// Existing behavior retained.
// ======================================================

const refreshAccessToken = async (refreshToken) => {
    try {
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
            new Date() > new Date(session.expires_at)
        ) {
            throw new Error('Invalid or expired refresh token');
        }

        const user = await findUserById(session.user_id);

        if (!user) {
            throw new Error('User not found');
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

        return {
            success: true,
            accessToken
        };
    } catch (error) {
        throw new Error('Invalid or expired refresh token');
    }
};


// ======================================================
// REVOKE SESSION
// ======================================================

const revokeUserSession = async (refreshToken) => {
    try {
        const refreshTokenHash = crypto
            .createHash('sha256')
            .update(refreshToken)
            .digest('hex');

        const session = await findSessionByRefreshTokenHash(
            refreshTokenHash
        );

        if (session) {
            await revokeSession(session.session_id);
        }

        return {
            success: true,
            message: 'Session revoked successfully. Token invalidated.'
        };
    } catch (error) {
        console.error('Revoke session error:', error);

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
