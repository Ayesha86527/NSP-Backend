// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./CertificateStorage.sol";


contract CertificateLogic is Ownable {

    CertificateStorage public certStorage;

    event CertificateMinted(bytes32 indexed certId, bytes32 dataHash);
    event CertificateRevoked(bytes32 indexed certId);
    event StorageAddressUpdated(address indexed oldStorage, address indexed newStorage);

    error ZeroAddress();

    constructor(address _storageAddress, address initialOwner) Ownable(initialOwner) {
        if (_storageAddress == address(0)) revert ZeroAddress();
        certStorage = CertificateStorage(_storageAddress);
    }

    function mintCertificate(
        bytes32 certId,
        bytes32 dataHash
    ) external onlyOwner {
        certStorage.setCertificate(certId, dataHash);
        emit CertificateMinted(certId, dataHash);
    }

    function revokeCertificate(bytes32 certId) external onlyOwner {
        certStorage.revokeCertificate(certId);
        emit CertificateRevoked(certId);
    }

    function verifyCertificate(bytes32 certId) external view returns (
        bool isValid,
        uint256 issuedAt,
        bytes32 dataHash
    ) {
        CertificateStorage.Certificate memory cert = certStorage.getCertificate(certId);

        if (cert.issuedAt == 0 || cert.isRevoked) {
            return (false, 0, bytes32(0));
        }

        return (true, cert.issuedAt, cert.dataHash);
    }

 
    function updateStorageAddress(address _newStorageAddress) external onlyOwner {
        if (_newStorageAddress == address(0)) revert ZeroAddress();
        address old = address(certStorage);
        certStorage = CertificateStorage(_newStorageAddress);
        emit StorageAddressUpdated(old, _newStorageAddress);
    }
}
