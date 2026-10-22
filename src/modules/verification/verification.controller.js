const { verifyCredentialOnChain } = require('./verification.service');

const verifyCredentialController = async (req, res, next) => {
    try {
        const { credentialId } = req.params;

        if (!credentialId) {
            return res.status(400).json({
                success: false,
                verified: false,
                message: 'Credential Id is required'
            });
        }

        const result = await verifyCredentialOnChain(credentialId);

        if (!result.success) {
            return res.status(404).json(result);
        }

        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
};

module.exports = {
    verifyCredentialController
};