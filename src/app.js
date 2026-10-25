require('dotenv').config();

const validateEnv = require('./config/validateEnv');
validateEnv();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { processMintingQueue } = require('./modules/ledger/blockchain/relayer');

const authRoutes = require('./modules/auth/auth.routes');
const candidateRoutes = require('./modules/candidate/candidate.routes');
const assessmentRoutes = require('./modules/candidate/assessment.routes');
const ledgerRoutes = require('./modules/ledger/ledger.routes');
const verificationRoutes = require('./modules/verification/verification.routes');
const superAdminRoutes = require('./modules/superAdmin/superAdmin.routes');
const queueRoutes = require('./modules/ledger/queue.routes');

const errorHandler = require('./middleware/errorHandler');

const {
    rateLimiter,
    authRateLimiter,
    verificationRateLimiter
} = require('./middleware/rateLimiter');

const app = express();

// Behind a load balancer every client would otherwise share one IP and one
// rate-limit bucket. TRUST_PROXY = number of proxy hops ("1" for a single ALB).
const trustProxy = (process.env.TRUST_PROXY || 'false').trim();
if (/^\d+$/.test(trustProxy)) {
    app.set('trust proxy', Number(trustProxy));
} else {
    app.set('trust proxy', trustProxy === 'true');
}

const allowedOrigins = new Set(
    (process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
);

app.use(helmet());

// NFR-SEC-01: only the Issuer Portal and Verifier DApp origins may call the
// API from a browser. Requests without an Origin header (server-to-server,
// curl, mobile apps) are not subject to CORS and are allowed through.
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
            return callback(null, true);
        }

        const error = new Error('Origin not allowed by CORS');
        error.statusCode = 403;
        return callback(error);
    }
}));

app.use(express.json());

// Express 5 leaves req.body undefined when a request has no body, which made
// every controller that destructures req.body throw a TypeError (HTTP 500).
app.use((req, res, next) => {
    if (req.body === undefined) {
        req.body = {};
    }
    next();
});

// NFR-PER-02: 60 req/min/IP on every route, plus dedicated per-route buckets.
app.use(rateLimiter);
app.use('/api/auth', authRateLimiter);
app.use('/api/verify', verificationRateLimiter);

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// Module routes
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/candidates', candidateRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/verify', verificationRoutes);
app.use('/api/ledger/queue', queueRoutes);

// Unknown routes return the standard JSON error shape.
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Error handler must remain last
app.use(errorHandler);

let server;
let mintingQueueTimer;

function startServer() {
    const PORT = Number(process.env.PORT || 3000);

    server = app.listen(PORT, () => {
        console.log(`NSP backend listening on port ${PORT}`);
    });

    // Start the worker only when running the server, not when importing app.js.
    mintingQueueTimer = setInterval(() => {
        processMintingQueue().catch((error) => {
            console.error('Minting queue timer error:', error.message);
        });
    }, 30000);

    const shutdown = (signal) => {
        console.log(`${signal} received, shutting down.`);
        clearInterval(mintingQueueTimer);
        server.close(() => process.exit(0));
        // Force exit if connections refuse to close.
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    return server;
}

// Last-resort guards so one bad promise cannot take the API down silently.
process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] Unhandled promise rejection:', reason);
});

if (require.main === module) {
    startServer();
}

module.exports = app;
module.exports.startServer = startServer;
