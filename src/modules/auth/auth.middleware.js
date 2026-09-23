const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
    try {
        const authorization = req.headers.authorization;

        if (!authorization) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const parts = authorization.split(' ');

        if (
            parts.length !== 2 ||
            parts[0] !== 'Bearer'
        ) {
            return res.status(401).json({
                success: false,
                message: 'Invalid authorization header'
            });
        }

        const token = parts[1];

        if (!process.env.JWT_SECRET) {
            throw new Error(
                'JWT_SECRET is not configured'
            );
        }

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET,
            {
                algorithms: ['HS256']
            }
        );

        req.user = {
            userId: decoded.sub,
            email: decoded.email,
            role: decoded.role,
            hubLocationId: decoded.hubLocationId
        };

        next();
    } catch (error) {
        if (
            error.name === 'TokenExpiredError'
        ) {
            return res.status(401).json({
                success: false,
                message: 'Access token expired'
            });
        }

        if (
            error.name === 'JsonWebTokenError'
        ) {
            return res.status(401).json({
                success: false,
                message: 'Invalid access token'
            });
        }

        next(error);
    }
};

const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
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