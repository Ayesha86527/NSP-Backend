import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const toBytes32 = (str: string) => ethers.keccak256(ethers.toUtf8Bytes(str));

const CERT_ID = toBytes32("CERT-2026-001");
const DATA_HASH = toBytes32("some-document-content");

async function deployFixture() {
  const [owner, otherAccount] = await ethers.getSigners();

  const storage = await ethers.deployContract("CertificateStorage", [owner.address]);
  const logic = await ethers.deployContract("CertificateLogic", [
    await storage.getAddress(),
    owner.address,
  ]);

  return { owner, otherAccount, storage, logic };
}

async function mintableFixture() {
  const fx = await deployFixture();
  await fx.storage.setAuthorizedCaller(await fx.logic.getAddress(), true);
  return fx;
}

async function mintedFixture() {
  const fx = await mintableFixture();
  await fx.logic.mintCertificate(CERT_ID, DATA_HASH);
  return fx;
}

describe("CertificateStorage + CertificateLogic", function () {
  describe("Deployment", function () {
    it("sets the right owner on both contracts", async function () {
      const { owner, storage, logic } = await networkHelpers.loadFixture(deployFixture);
      expect(await storage.owner()).to.equal(owner.address);
      expect(await logic.owner()).to.equal(owner.address);
    });

    it("points CertificateLogic at the storage contract", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(deployFixture);
      expect(await logic.certStorage()).to.equal(await storage.getAddress());
    });

    it("rejects a zero storage address at deploy time", async function () {
      const [owner] = await ethers.getSigners();
      const Logic = await ethers.getContractFactory("CertificateLogic");
      await expect(
        Logic.deploy(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(Logic, "ZeroAddress");
    });
  });

  describe("Authorization wiring", function () {
    it("blocks minting before the logic contract is authorized", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        logic.mintCertificate(CERT_ID, DATA_HASH)
      ).to.be.revertedWithCustomError(storage, "NotAuthorized");
    });

    it("only the storage owner can authorize a caller", async function () {
      const { otherAccount, storage, logic } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        storage.connect(otherAccount).setAuthorizedCaller(await logic.getAddress(), true)
      ).to.be.revertedWithCustomError(storage, "OwnableUnauthorizedAccount");
    });

    it("rejects authorizing the zero address", async function () {
      const { storage } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        storage.setAuthorizedCaller(ethers.ZeroAddress, true)
      ).to.be.revertedWithCustomError(storage, "ZeroAddress");
    });

    it("emits CallerAuthorized and allows minting once authorized", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(deployFixture);
      await expect(storage.setAuthorizedCaller(await logic.getAddress(), true))
        .to.emit(storage, "CallerAuthorized")
        .withArgs(await logic.getAddress(), true);

      await expect(logic.mintCertificate(CERT_ID, DATA_HASH)).to.not.revert(ethers);
    });

    it("can revoke authorization, blocking further mints", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(mintableFixture);
      const logicAddr = await logic.getAddress();
      await storage.setAuthorizedCaller(logicAddr, false);

      await expect(
        logic.mintCertificate(CERT_ID, DATA_HASH)
      ).to.be.revertedWithCustomError(storage, "NotAuthorized");
    });
  });

  describe("Minting", function () {
    it("only the logic contract's owner can mint", async function () {
      const { otherAccount, logic } = await networkHelpers.loadFixture(mintableFixture);
      await expect(
        logic.connect(otherAccount).mintCertificate(CERT_ID, DATA_HASH)
      ).to.be.revertedWithCustomError(logic, "OwnableUnauthorizedAccount");
    });

    it("mints and emits CertificateMinted with the real cert id", async function () {
      const { logic } = await networkHelpers.loadFixture(mintableFixture);
      await expect(logic.mintCertificate(CERT_ID, DATA_HASH))
        .to.emit(logic, "CertificateMinted")
        .withArgs(CERT_ID, DATA_HASH);
    });

    it("stores retrievable data", async function () {
      const { logic } = await networkHelpers.loadFixture(mintedFixture);
      const [isValid, issuedAt, dataHash] = await logic.verifyCertificate(CERT_ID);

      expect(isValid).to.equal(true);
      expect(dataHash).to.equal(DATA_HASH);
      expect(issuedAt).to.be.greaterThan(0n);
    });

    it("rejects minting the same cert id twice", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(mintedFixture);
      await expect(logic.mintCertificate(CERT_ID, DATA_HASH))
        .to.be.revertedWithCustomError(storage, "CertificateAlreadyExists")
        .withArgs(CERT_ID);
    });

    it("does not let re-minting revive a revoked certificate", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(mintedFixture);
      await logic.revokeCertificate(CERT_ID);

      await expect(logic.mintCertificate(CERT_ID, DATA_HASH))
        .to.be.revertedWithCustomError(storage, "CertificateAlreadyExists");
    });
  });

  describe("Revocation", function () {
    it("only the logic contract's owner can revoke", async function () {
      const { otherAccount, logic } = await networkHelpers.loadFixture(mintedFixture);
      await expect(
        logic.connect(otherAccount).revokeCertificate(CERT_ID)
      ).to.be.revertedWithCustomError(logic, "OwnableUnauthorizedAccount");
    });

    it("revokes and emits CertificateRevoked", async function () {
      const { logic } = await networkHelpers.loadFixture(mintedFixture);
      await expect(logic.revokeCertificate(CERT_ID))
        .to.emit(logic, "CertificateRevoked")
        .withArgs(CERT_ID);
    });

    it("verifyCertificate reports invalid after revocation", async function () {
      const { logic } = await networkHelpers.loadFixture(mintedFixture);
      await logic.revokeCertificate(CERT_ID);
      const [isValid] = await logic.verifyCertificate(CERT_ID);
      expect(isValid).to.equal(false);
    });

    it("rejects revoking a cert id that was never minted", async function () {
      const { storage, logic } = await networkHelpers.loadFixture(mintedFixture);
      const fakeId = toBytes32("does-not-exist");
      await expect(logic.revokeCertificate(fakeId))
        .to.be.revertedWithCustomError(storage, "CertificateNotFound")
        .withArgs(fakeId);
    });
  });

  describe("verifyCertificate on unknown ids", function () {
    it("returns isValid = false, not a revert, for an unminted id", async function () {
      const { logic } = await networkHelpers.loadFixture(deployFixture);
      const [isValid, issuedAt, dataHash] = await logic.verifyCertificate(
        toBytes32("never-minted")
      );
      expect(isValid).to.equal(false);
      expect(issuedAt).to.equal(0n);
      expect(dataHash).to.equal(ethers.ZeroHash);
    });
  });

  describe("Swapping the storage contract", function () {
    it("rejects pointing at the zero address", async function () {
      const { logic } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        logic.updateStorageAddress(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(logic, "ZeroAddress");
    });

    it("only the owner can update the storage address", async function () {
      const { owner, otherAccount, logic } = await networkHelpers.loadFixture(deployFixture);
      const newStorage = await ethers.deployContract("CertificateStorage", [owner.address]);

      await expect(
        logic.connect(otherAccount).updateStorageAddress(await newStorage.getAddress())
      ).to.be.revertedWithCustomError(logic, "OwnableUnauthorizedAccount");
    });

    it("emits StorageAddressUpdated and requires re-authorization on the new storage", async function () {
      const { owner, storage, logic } = await networkHelpers.loadFixture(deployFixture);
      const oldStorageAddr = await storage.getAddress();

      const newStorage = await ethers.deployContract("CertificateStorage", [owner.address]);
      const newStorageAddr = await newStorage.getAddress();

      await expect(logic.updateStorageAddress(newStorageAddr))
        .to.emit(logic, "StorageAddressUpdated")
        .withArgs(oldStorageAddr, newStorageAddr);

      expect(await logic.certStorage()).to.equal(newStorageAddr);

      // Not authorized on the new storage yet -> mint still fails.
      await expect(
        logic.mintCertificate(CERT_ID, DATA_HASH)
      ).to.be.revertedWithCustomError(newStorage, "NotAuthorized");

      // Authorize on the new storage -> mint succeeds.
      await newStorage.setAuthorizedCaller(await logic.getAddress(), true);
      await expect(logic.mintCertificate(CERT_ID, DATA_HASH)).to.not.revert(ethers);
    });
  });
});