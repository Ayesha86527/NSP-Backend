const LedgerModel = require('./ledger.model');
const { processMintingQueue } = require('./blockchain/relayer'); 

const getQueueHealthController = async (req, res, next) => {
    try {
        const stats = await LedgerModel.getQueueHealthStats();
        return res.status(200).json({
            success: true,
            queueStats: stats
        });
    } catch (error) {
        next(error);
    }
};



const triggerQueueController = async (req, res, next) => {
    try {
   
        processMintingQueue();
        return res.status(200).json({
            success: true,
            message: 'Minting queue processing triggered successfully.'
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getQueueHealthController,
    triggerQueueController
};