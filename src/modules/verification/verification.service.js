const redis = require('./../../config/redis.js');
const ledgerModule = require('../ledger/ledger.model.js');
const { ethers } = require('ethers');
const { getReadOnlyContractInstance } = require('../ledger/blockchain/contract');

const CACHE_TTL = 60;          
const NEGATIVE_CACHE_TTL = 10; 

const verifyCredentialOnChain = async (credentialId) => {
    const cacheKey = `verify:${credentialId}`;

    try {
        
        const cachedResult = await redis.get(cacheKey);
        if (cachedResult) {
            return JSON.parse(cachedResult);
        }

       
        const credential = await ledgerModule.getCredentialByStringId(credentialId);
        if (!credential) {
            return {
                success: false,
                verified: false,
                message: 'Credential not found off-chain.'
            };
        }

       
        if (credential.status === 'REVOKED') {
            const revokedResponse = {
                success: true,
                verified: false,
                status: 'REVOKED',
                message: 'Credential has been revoked.'
            };
            await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(revokedResponse));
            return revokedResponse;
        }


        const contract = getReadOnlyContractInstance();
        const certIdBytes32 = ethers.id(credentialId);

        const [isValid, issuedAt, onChainHash] = await contract.verifyCertificate(certIdBytes32);

        let verificationResult;

        if (!isValid || Number(issuedAt) === 0) {
            verificationResult = {
                success: true,
                verified: false,
                status: 'NOT_FOUND_ON_CHAIN',
                message: 'Credential is not active or minted on-chain.'
            };
        } else if (onChainHash.toLowerCase() !== credential.root_hash.toLowerCase()) {
            verificationResult = {
                success: true,
                verified: false,
                status: 'TAMPERED',
                message: 'On-chain hash does not match local metadata root hash.'
            };
        } else {
            verificationResult = {
                success: true,
                verified: true,
                status: 'VALID',
                data: {
                    credentialId,
                    issuedAt: new Date(Number(issuedAt) * 1000).toISOString(),
                    onChainHash
                }
            };
        }

        
        const ttl = verificationResult.status === 'VALID' ? CACHE_TTL : NEGATIVE_CACHE_TTL;
        await redis.setex(cacheKey, ttl, JSON.stringify(verificationResult));

        return verificationResult;
    } catch (error) {
        console.error('Verification service error:', error.message);
        throw error;
    }
};

module.exports = {
    verifyCredentialOnChain
};