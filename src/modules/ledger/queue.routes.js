const express = require('express');
const router = express.Router();
const { 
    getQueueHealthController, 
    triggerQueueController 
} = require('./queue.controller');
const { 
    authenticate, 
    requireRole 
} = require('../auth/auth.middleware');


router.get(
    '/health',
    authenticate,
    requireRole('TRADE_TESTER', 'CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    getQueueHealthController
);


router.post(
    '/trigger',
    authenticate,
    requireRole('CENTER_SUPERINTENDENT', 'SUPER_ADMIN'),
    triggerQueueController
);




module.exports = router;