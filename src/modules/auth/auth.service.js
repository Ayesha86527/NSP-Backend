const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify } = require('otplib');

const {
    findUserByEmail,
    findUserForMfa
} = require('./auth.model');

const login = async (email, password) => {
    const user = await findUserByEmail(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    const passwordMatches = await bcrypt.compare(
        password,
        user.password_hash
    );

    if (!passwordMatches) {
        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

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

const decryptMfaSecret = (encryptedSecret) => {
    const parts = encryptedSecret.split(':');

    if (parts.length !== 3) {
        throw new Error('Invalid encrypted MFA secret format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    if (!process.env.MFA_ENCRYPTION_KEY) {
        throw new Error(
            'MFA_ENCRYPTION_KEY is not configured'
        );
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

const verifyMfa = async (email, mfaCode) => {
    const user = await findUserForMfa(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (!user.is_mfa_active) {
        return {
            success: false,
            message: 'MFA is not active'
        };
    }

    const mfaSecret = decryptMfaSecret(
        user.mfa_secret
    );

    const isValid = await verify({
        secret: mfaSecret,
        token: mfaCode
    });

    if (!isValid) {
        return {
            success: false,
            message: 'Invalid MFA code'
        };
    }

    if (!process.env.JWT_SECRET) {
        throw new Error(
            'JWT_SECRET is not configured'
        );
    }

    const accessToken = jwt.sign(
        {
            sub: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        },
        process.env.JWT_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: process.env.JWT_EXPIRES_IN || '15m'
        }
    );

    return {
        success: true,
        message: 'Login successful',
        accessToken,
        tokenType: 'Bearer',
        expiresIn: process.env.JWT_EXPIRES_IN || '15m',
        user: {
            id: user.user_id,
            email: user.email,
            role: user.role,
            hubLocationId: user.hub_location_id
        }
    };
};

module.exports = {
    login,
    verifyMfa
};