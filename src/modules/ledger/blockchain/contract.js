require('dotenv').config();
const { ethers } = require('ethers');

const contractABI = [
    'function mintCertificate(bytes32 certId, bytes32 dataHash) external',
    'function revokeCertificate(bytes32 certId) external',
    'function verifyCertificate(bytes32 certId) external view returns (bool isValid, uint256 issuedAt, bytes32 dataHash)',
    'function owner() external view returns (address)'
];

let provider;

const getProvider = () => {
    const rpcUrl = process.env.POLYGON_AMOY_RPC_URL;
    if (!rpcUrl) {
        throw new Error('POLYGON_AMOY_RPC_URL is not configured.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(rpcUrl);
    } catch {
        throw new Error('POLYGON_AMOY_RPC_URL must be a valid URL.');
    }
    const isLocalHttp = parsedUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname);
    if (parsedUrl.protocol !== 'https:' && !isLocalHttp) {
        throw new Error('POLYGON_AMOY_RPC_URL must use HTTPS except for local development.');
    }

    if (!provider) {
        provider = new ethers.JsonRpcProvider(parsedUrl.toString());
    }
    return provider;
};

const getContractAddress = () => {
    const contractAddress = process.env.CERTIFICATE_LOGIC_CONTRACT_ADDRESS;
    if (!contractAddress || !ethers.isAddress(contractAddress)) {
        throw new Error('CERTIFICATE_LOGIC_CONTRACT_ADDRESS is missing or invalid.');
    }
    return ethers.getAddress(contractAddress);
};

const getReadOnlyContractInstance = () => new ethers.Contract(
    getContractAddress(),
    contractABI,
    getProvider()
);

const getContractInstance = () => {
    const privateKey = process.env.RELAYER_PRIVATE_KEY ;
    if (!privateKey) {
        throw new Error('RELAYER_PRIVATE_KEY is not configured.');
    }

    const signer = new ethers.Wallet(privateKey, getProvider());
    return new ethers.Contract(
        getContractAddress(),
        contractABI,
        signer
    );
};

module.exports = {
    getProvider,
    getReadOnlyContractInstance,
    getContractInstance
};
