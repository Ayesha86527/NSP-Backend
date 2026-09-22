const jwt = require('jsonwebtoken');

const {
    publicKey
} = require('../../config/jwt');


const authenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (
            !authHeader ||
            !authHeader.startsWith('Bearer ')
        ) {
            return res.status(401).json({
                success: false,
                message: 'Authorization token is required'
            });
        }

        const token = authHeader.substring(7);

        const decoded = jwt.verify(
            token,
            publicKey,
            {
                algorithms: ['RS256']
            }
        );

        req.user = {
            id: decoded.sub,
            email: decoded.email,
            role: decoded.role
        };

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired access token'
        });
    }
};


/*
 * ROLE AUTHORIZATION
 *
 * Usage:
 * router.get(
 *     '/example',
 *     authenticate,
 *     requireRole('TRADE_TESTER'),
 *     controller.example
 * );
 */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        next();
    };
};


module.exports = {
    authenticate,
    requireRole
};