const { ethers } = require('ethers');
const { getContractInstance, getProvider } = require('./contract');
const LedgerModel = require('../ledger.model');
const {checkRelayerBalance}=require('./contract')
let isProcessingQueue = false;

const stringToBytes32 = (str) => {
    return ethers.id(str); // to generate a keccak256 hash bytes32 from string
};

const processMintingQueue = async () => {
    if (isProcessingQueue) {
        return;
    }

    isProcessingQueue = true;
    try {
        try {
            const provider = getProvider();
            const privateKey = process.env.RELAYER_PRIVATE_KEY;
            if (privateKey) {
                const relayerWallet = new ethers.Wallet(privateKey, provider);
                await checkRelayerBalance(provider, relayerWallet);
            }
        } catch (balanceError) {
            console.error('Relayer balance check warning:', balanceError.message);
        }
        const pendingItems = await LedgerModel.getPendingQueueItems();

        if (!pendingItems || pendingItems.length === 0) {
            console.log('No pending items in the minting queue.');
            return;
        }
        const contract =await getContractInstance();
        for (const pendingItem of pendingItems) {
            try {
                const item = await LedgerModel.claimQueueItem(pendingItem.id);
                if (!item) {
                    continue;
                }
                const payload = typeof item.payload === 'string'
                    ? JSON.parse(item.payload)
                    : item.payload;
                const { credentialId, rootHash } = payload;
                if (
                    credentialId !== item.credential_id ||
                    !ethers.isHexString(rootHash, 32)
                ) {
                    throw new Error('Minting queue payload is invalid.');
                }
                const certIdBytes32 = stringToBytes32(credentialId);

                const [isValid, , onChainHash] = await contract.verifyCertificate(certIdBytes32);
                if (isValid) {
                    if (onChainHash.toLowerCase() !== rootHash.toLowerCase()) {
                        throw new Error(`On-chain hash does not match queue item for credential ${credentialId}.`);
                    }
                    await LedgerModel.updateQueueStatus(item.id, 'MINTED', item.tx_hash);
                    console.log(`Credential ${credentialId} is already minted on-chain.`);
                    continue;
                }

                const tx = await contract.mintCertificate(certIdBytes32, rootHash);
                const receipt = await tx.wait();
                if (!receipt || receipt.status !== 1) {
                    throw new Error('Blockchain transaction was not confirmed successfully.');
                }

                await LedgerModel.updateQueueStatus(item.id, 'MINTED', receipt.hash);
                console.log(`Successfully minted credential ${credentialId} with transaction hash: ${receipt.hash}`);
            } catch (error) {
                console.error(`Failed to mint queue item ID ${pendingItem.id}:`, error.message);
                try {
                    await LedgerModel.updateQueueStatus(
                        pendingItem.id,
                        'FAILED',
                        null,
                        error.message.slice(0, 1000)
                    );
                } catch (statusError) {
                    console.error(`Failed to mark queue item ID ${pendingItem.id} as FAILED:`, statusError.message);
                }
            }
        }
    } catch (error) {
        console.error('Failed to process minting queue:', error.message);
    } finally {
        isProcessingQueue = false;
    }
};

module.exports = {
    processMintingQueue
};