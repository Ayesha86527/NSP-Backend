const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { verify } = require('otplib');

const {
    findUserByEmail,
    findUserForMfa
} = require('./auth.model');

const {
    privateKey,
    accessTokenExpiresIn
} = require('../../config/jwt');


/*
 * Login with email and password.
 *
 * Password verification is the first authentication step.
 * MFA is required before an access token is issued.
 */
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

    /*
     * Both Trade Testers and Center Superintendents
     * are allowed to use the portal.
     */
    if (
        user.role !== 'TRADE_TESTER' &&
        user.role !== 'CENTER_SUPERINTENDENT'
    ) {
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
 * Decrypt the AES-256-GCM encrypted MFA secret.
 */
const decryptMfaSecret = (encryptedSecret) => {
    const parts = encryptedSecret.split(':');

    if (parts.length !== 3) {
        throw new Error(
            'Invalid encrypted MFA secret format'
        );
    }

    const [
        ivHex,
        authTagHex,
        encryptedHex
    ] = parts;

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

    const iv = Buffer.from(
        ivHex,
        'hex'
    );

    const authTag = Buffer.from(
        authTagHex,
        'hex'
    );

    const encrypted = Buffer.from(
        encryptedHex,
        'hex'
    );

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
 * Verify MFA and issue an RS256 access token.
 */
const verifyMfa = async (
    email,
    mfaCode
) => {
    const user = await findUserForMfa(email);

    if (!user) {
        return {
            success: false,
            message: 'Invalid user'
        };
    }

    /*
     * Only roles supported by the portal can complete login.
     */
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

    /*
     * Include the user's hub in the JWT.
     *
     * Superintendent authorization uses this value
     * for hub-level access control.
     */
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
        message: 'Login successful',
        accessToken,
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


const refreshAccessToken=async(refreshToken)=>{
    try{    
        const decode=jwt.verify(refreshToken , process.env.REFRESH_TOKEN_SECRET || 'secret .. .. .. .')
        const accessToken=jwt.sign({userId:decode.userId , email:decode.email} , 
            process.env.JWT_SECRET,
            {expiresIn:"15m"}
        );
        return {accessToken};
    }catch(err){
        throw new Error('Invalid or expired refresh token .. .. . .');

    }
}
const revokeUserSession = async (userId, email, refreshToken, ipAddress) => {
    try {
        const query = `DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2`;
        await db.query(query, [refreshToken, userId]);
        return {
            success: true,
            message: "Session revoked successfully. Token invalidated."
        };

    } catch (error) {
        console.error("Revoke session error:", error);
        return {
            success: false,
            message: "Failed to revoke session"
        };
    }
};
module.exports = {
    login,
    verifyMfa,
    revokeUserSession,
    refreshAccessToken
};