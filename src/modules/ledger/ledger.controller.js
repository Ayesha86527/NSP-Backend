const LedgerService = require('./ledger.service');
const { getReadOnlyContractInstance, getProvider } = require('./blockchain/contract');
const { ethers } = require('ethers');
const LedgerModule=require('./ledger.model')
const{processMintingQueue}=require('./blockchain/relayer')
const handleControllerError = (error, res) => {
    if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({
            success: false,
            error: error.message
        });
    }

    console.error('Ledger request failed:', error.stack || error.message);
    return res.status(500).json({
        success: false,
        error: 'Ledger request could not be completed.'
    });
};

const issueCredentialController = async (req, res) => {
    try {
        const result = await LedgerService.issueCredentialOnly(
            req.body,
            req.user
        );
        return res.status(201).json({
            success: true,
            message: 'Credential issued and stored pending approval.',
            data: result
        });
    } catch (error) {
        return handleControllerError(error, res);
    }
};

const approveCredentialController = async (req, res) => {
    try {
        const { credentialId } = req.body || {};
        const result = await LedgerService.approveAndQueueCredential(
            credentialId,
            req.user
        );
        return res.status(200).json({
            success: true,
            message: result.status === 'MINTED'
                ? 'Credential is already minted.'
                : 'Credential approved and added to the blockchain minting queue.',
            data: result
        });
    } catch (error) {
        return handleControllerError(error, res);
    }
};

const getCredentialStatusController = async (req, res) => {
    try {
        const result = await LedgerService.getCredentialStatus(
            req.params.credentialId,
            req.user
        );
        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        return handleControllerError(error, res);
    }
};

const verifyCredentialController = async (req, res) => {
    try {
        const { credentialId } = req.params;
        LedgerService.validateCredentialId(credentialId);

        const contract = getReadOnlyContractInstance();
        const [isValid, issuedAt, dataHash] = await contract.verifyCertificate(
            ethers.id(credentialId)
        );

        if (!isValid) {
            return res.status(404).json({
                success: false,
                verified: false,
                message: 'Credential not found, revoked, or invalid on-chain.'
            });
        }

        if (issuedAt > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('The on-chain issuance timestamp is out of range.');
        }

        return res.status(200).json({
            success: true,
            verified: true,
            data: {
                credentialId,
                issuedAt: new Date(Number(issuedAt) * 1000).toISOString(),
                onChainHash: dataHash
            }
        });
    } catch (error) {
        return handleControllerError(error, res);
    }
};

const revokeCredentialController = async (req, res, next) => {
    try {
        const { credentialId } = req.params;
        const { reason } = req.body;
        const user = req.user; 

        const result = await LedgerService.revokeCredential(credentialId, reason, user);

        return res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const getRelayerBalanceController = async (req, res, next) => {
    try {
        const provider = getProvider();
        const privateKey = process.env.RELAYER_PRIVATE_KEY;
        
        const relayerWallet = new ethers.Wallet(privateKey, provider);
        

        const balance = await provider.getBalance(relayerWallet.address);
        const balanceMatic = ethers.formatEther(balance);
        
        const thresholdInput = process.env.MIN_GAS_THRESHOLD || "1";
        const checkThreshold = ethers.parseEther(thresholdInput);
        const isLowGas = balance < checkThreshold;

        return res.status(200).json({
            success: true,
            walletAddress: relayerWallet.address,
            balanceMatic: balanceMatic,
            isLowGas: isLowGas,
            message: isLowGas ? 'Warning: Relayer balance is critically low!' : 'Balance is sufficient.'
        });
    } catch (error) {
        next(error);
    }
};




module.exports = {
    issueCredentialController,
    approveCredentialController,
    getCredentialStatusController,
    verifyCredentialController,
    revokeCredentialController,
    getRelayerBalanceController
    
};
