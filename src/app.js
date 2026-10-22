require('dotenv').config();
const assessmentRoutes =
    require('./modules/candidate/assessment.routes');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { processMintingQueue } = require('./modules/ledger/blockchain/relayer.js');

const authRoutes = require('./modules/auth/auth.routes');
const candidateRoutes = require('./modules/candidate/candidate.routes');
const ledgerRoutes = require('./modules/ledger/ledger.routes');
const verificationRoutes = require('./modules/verification/verification.routes');
const superAdminRoutes = require('./modules/superAdmin/superAdmin.routes');
const queueRoutes = require('./modules/ledger/queue.routes');

const errorHandler = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');

const app = express();

// --- Core middleware ---
app.use(helmet());                 // sets basic security headers (NFR-SEC baseline)
app.use(cors());                   // tighten allowed origins before production
app.use(express.json());
app.use(rateLimiter);              // FR-AUTH-06 / NFR-PER-02 — 60 req/min/IP target
app.use('/api/super-admin', superAdminRoutes);

// --- Health check (deploy this first, before any module logic) ---
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Module routes — mirrors SRS Sections 4.1–4.4 ---
app.use('/api/auth', authRoutes);              // FR-AUTH-xx
app.use('/api/candidates', candidateRoutes);
app.use(
    '/api/assessments',
    assessmentRoutes
);   // FR-CAND-xx
app.use('/api/ledger', ledgerRoutes);          // FR-LEDG-xx
app.use('/api/verify', verificationRoutes);    // FR-VERI-xx (public, no auth middleware)
app.use('/api/ledger/queue', queueRoutes);

// --- Error handling — must be last ---
app.use(errorHandler);
setInterval(() => {
    processMintingQueue();
}, 30000);
//fixed // / 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NSP backend listening on port ${PORT}`);

  
});

module.exports = app; // exported for testing