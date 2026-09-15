// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/Ownable.sol";


contract CertificateStorage is Ownable {

    struct Certificate {
        uint256 issuedAt;
        bool isRevoked;
        bytes32 dataHash;
    }

    mapping(bytes32 => Certificate) private certificates;

    mapping(address => bool) public authorizedCallers;

    event CallerAuthorized(address indexed caller, bool authorized);
    event CertificateSet(bytes32 indexed certId, bytes32 dataHash, uint256 issuedAt);
    event CertificateRevoked(bytes32 indexed certId);

    error NotAuthorized();
    error CertificateAlreadyExists(bytes32 certId);
    error CertificateNotFound(bytes32 certId);
    error ZeroAddress();

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {}


    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        authorizedCallers[caller] = authorized;
        emit CallerAuthorized(caller, authorized);
    }

    function setCertificate(bytes32 certId, bytes32 dataHash) external onlyAuthorized {
        if (certificates[certId].issuedAt != 0) revert CertificateAlreadyExists(certId);

        certificates[certId] = Certificate({
            issuedAt: block.timestamp,
            isRevoked: false,
            dataHash: dataHash
        });

        emit CertificateSet(certId, dataHash, block.timestamp);
    }

    function revokeCertificate(bytes32 certId) external onlyAuthorized {
        Certificate storage cert = certificates[certId];
        if (cert.issuedAt == 0) revert CertificateNotFound(certId);

        cert.isRevoked = true;
        emit CertificateRevoked(certId);
    }

    function getCertificate(bytes32 certId) external view returns (Certificate memory) {
        return certificates[certId];
    }
}
