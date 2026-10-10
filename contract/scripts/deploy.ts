import { network } from "hardhat";

const { ethers } = await network.create();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(" Deploying contracts with the account:", deployer.address);

  // 1. Deploy CertificateStorage
  console.log("Deploying CertificateStorage...");
  const storage = await ethers.deployContract("CertificateStorage", [deployer.address]);
  await storage.waitForDeployment();
  const storageAddress = await storage.getAddress();
  console.log(`CertificateStorage deployed to: ${storageAddress}`);

  // 2. Deploy CertificateLogic
  console.log("Deploying CertificateLogic...");
  const logic = await ethers.deployContract("CertificateLogic", [
    storageAddress,
    deployer.address,
  ]);
  await logic.waitForDeployment();
  const logicAddress = await logic.getAddress();
  console.log(`CertificateLogic deployed to: ${logicAddress}`);

  // 3. Authorize CertificateLogic in CertificateStorage
  console.log(" Authorizing CertificateLogic in CertificateStorage...");
  const tx = await storage.setAuthorizedCaller(logicAddress, true);
  await tx.wait();
  console.log("CertificateLogic successfully authorized as a caller!");

  console.log("\n----------------------------------------");
  console.log("Deployment & Wiring Complete!");
  console.log("----------------------------------------");
  console.log(`CertificateStorage Address: ${storageAddress}`);
  console.log(`CertificateLogic Address:   ${logicAddress}`);
  console.log("----------------------------------------");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});