const rateLimit = require('express-rate-limit');

// DoD: rate limits on all endpoints, 60 requests/minute per IP.
// Override with RATE_LIMIT_PER_MINUTE only if the lead approves a change.
const WINDOW_MS = 60 * 1000;
const limitPerMinute = () => Number(process.env.RATE_LIMIT_PER_MINUTE || 60);

const createRateLimiter = (message) =>
    rateLimit({
        windowMs: WINDOW_MS,
        limit: limitPerMinute,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        // Do not count CORS preflights against a browser client's budget.
        skip: (req) => req.method === 'OPTIONS',
        message: {
            success: false,
            message
        }
    });

// Global protection for every route.
const rateLimiter = createRateLimiter(
    'Too many requests. Please try again later.'
);

// /api/auth/* (NFR-PER-02)
const authRateLimiter = createRateLimiter(
    'Too many authentication requests. Please try again later.'
);

// Public verification: /api/verify/* (NFR-PER-02, DDoS mitigation)
const verificationRateLimiter = createRateLimiter(
    'Too many verification requests. Please try again later.'
);

module.exports = {
    rateLimiter,
    authRateLimiter,
    verificationRateLimiter
};
