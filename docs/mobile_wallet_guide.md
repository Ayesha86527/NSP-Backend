# NSP — Worker Mobile Wallet & Mobile Verifier Integration Guide

**Audience:** Mobile Application Developers (React Native / Flutter / Android / iOS)  
**Target Applications:** 
1. **Worker Mobile Wallet** (Candidate credential holder app)
2. **Mobile Verifier Mode** (Employer & immigration inspector camera QR scanner)  
**Backend Status:** Blockchain Ledger, Polygon Amoy Relayer, and Public Verification APIs are **LIVE**.

---

## 0. Executive Overview & Architecture

Unlike the Issuer Portal (which is restricted to testing hub staff and enforces passwords, TOTP MFA, laptop fingerprinting, and account lockout), the **Worker Mobile Wallet** is built around an **open, citizen-first, zero-auth architecture**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 TESTING HUB / BACKEND                                  │
│  Candidate Assessed ──► Superintendent Approves ──► Polygon Amoy On-Chain Anchoring    │
│  Canonical Credential ID: urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18               │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ Activation Deep-Link / QR Code
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        WORKER MOBILE WALLET (React Native)                             │
│  1. One-Time Activation (No Portal Password/MFA required)                             │
│  2. Encrypted Local Storage (iOS Keychain / Android EncryptedSharedPreferences)        │
│  3. Offline Presentation (High-contrast QR + Dynamic Digital Passport)                 │
│  4. Background Sync: GET /api/ledger/verify/:credentialId (Live Polygon Status)        │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ Scanned by Employer / Embassy
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                         EMPLOYER / VERIFIER CAMERA SCANNER                             │
│  Scans QR ──► GET /api/verify/:credentialId (Zero Auth, Direct Polygon Query)           │
│  Displays Instant Cryptographic Proof: Verified / On-Chain Timestamp / Tx Hash         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Core Functional Requirements (TOR & SDD Traceability)

The mobile developer must satisfy the following formal requirements:

| Requirement ID | Specification | Mobile App Implementation |
| :--- | :--- | :--- |
| **`FR-WAL-01`** | **Dynamic Scannable QR Code** | Render high-contrast QR pattern encoding canonical verification URL (`https://verifier.nsp.gov.pk/verify?id=...`). |
| **`FR-WAL-02`** | **Shareable / Printable PDF** | Generate a downloadable, styled National Skills Passport PDF complete with QR code, candidate photo, trade scores, and transaction hash. |
| **`FR-WAL-03`** | **Offline Encrypted Storage** | Encrypt and store credential payload on-device (iOS Keychain / Android Keystore) so workers can present their passport in airports or areas with zero cellular reception. |
| **`FR-WAL-04`** | **Live Blockchain Reconciliation** | When internet is active, query backend public verification API to show live status (`Verified on Blockchain` vs `Revoked`). |
| **`FR-WAL-05`** | **Low-Literacy Friendly Layout** | Clean visual hierarchy, prominent trade badges, bilingual (English/Urdu) labels, and clear green/red status indicators. |
| **`FR-VER-01`** | **Camera QR Scanner (Verifier)** | In-app camera scanner that reads passport QR codes and directly validates credentials against the blockchain. |

---

## 2. W3C Verifiable Credential Data Model

When a worker's credential is activated, the mobile app holds the following W3C-compliant Verifiable Credential object:

```json
{
  "credential_id": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
  "candidate_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "APPROVED",
  "minting_status": "MINTED",
  "tx_hash": "0x3a4b5c6d7e8f90123456789abcdef0123456789abcdef0123456789abcdef01",
  "issued_at": "2026-10-21T09:30:00.000Z",
  "credential_subject": {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schema.nsp.gov.pk/contexts/v1.json"
    ],
    "id": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
    "type": ["VerifiableCredential", "NationalSkillsCredential"],
    "issuer": "did:nsp:hub:peshawar-01",
    "issuanceDate": "2026-10-21T09:30:00.000Z",
    "credentialSubject": {
      "id": "did:nsp:candidate:3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "candidateName": "Muhammad Aslam Khan",
      "cnicMasked": "17301-*******-5",
      "skillName": "Solar PV Installation & Maintenance",
      "awardLevel": "Level 2 (Skilled)",
      "practicalScore": 88.0,
      "theoryScore": 92.5,
      "totalScore": 90.25,
      "photoUri": "https://s3.ap-southeast-1.amazonaws.com/nsp-photos/candidates/3fa85f64...jpg"
    }
  }
}
```

### Key UI Display Elements:
1. **Header:** National Skills Passport — Government of Pakistan / KP TEVTA.
2. **Worker Profile:** Photograph (`photoUri`), Full Name, Masked CNIC (`17301-*******-5` — PII protection rule).
3. **Certified Trade:** Trade name (`skillName`) and Qualification level (`awardLevel`).
4. **Performance Scores:** Practical score, Theory score, and Combined grade.
5. **Blockchain Stamp:** Polygon Transaction Hash (`tx_hash`) and Status Badge (`Anchored on-chain`).

---

## 3. Scannable QR Code Standard (`FR-WAL-01`)

The mobile wallet must render a scannable QR code on the primary passport screen.

### 3.1 Canonical URL Format
The QR code must encode a direct URL pointing to the national verification service:
```text
https://verifier.nsp.gov.pk/verify?id=urn%3Auuid%3A8b3e811c-d7a8-4395-8147-380ff9ba7c18
```

### 3.2 QR Construction Parameters
* **Content:** `https://verifier.nsp.gov.pk/verify?id=${encodeURIComponent(credential_id)}`
* **Error Correction Level:** **Level M (15%)** or **Level Q (25%)** (ensures readability even on scratched phone screens).
* **Render Size:** Minimum `240x240` logical pixels with high contrast (solid black on solid white background with 4-pixel quiet zone).
* **Brightness Trigger:** When the worker taps the QR code to present it, auto-boost device screen brightness to 100%.

---

## 4. Public On-Chain Verification API (`FR-WAL-04`)

The mobile app calls the backend verification endpoint to check if the credential is live on the Polygon Amoy blockchain.

### 4.1 Endpoint Details
* **Method:** `GET`
* **Primary URL:** `/api/ledger/verify/:credentialId`
* **Alias URL:** `/api/verify/:credentialId`
* **Authentication:** **None** (Public endpoint, zero headers required).
* **Rate Limit:** 60 requests/minute per IP.

### 4.2 Example Request
```http
GET /api/ledger/verify/urn%3Auuid%3A8b3e811c-d7a8-4395-8147-380ff9ba7c18 HTTP/1.1
Host: api.nsp.gov.pk
Accept: application/json
```

### 4.3 Response Contracts

#### Case A: Valid Credential Anchored On-Chain (`200 OK`)
```json
{
  "success": true,
  "verified": true,
  "data": {
    "credentialId": "urn:uuid:8b3e811c-d7a8-4395-8147-380ff9ba7c18",
    "issuedAt": "2026-10-21T09:30:00.000Z",
    "onChainHash": "0x4b78c92a10b80f2d4e8c1a7b8e9f0123456789abcdef0123456789abcdef0123"
  }
}
```
* **UI Action:** Display green checkmark: **"Cryptographically Verified on Polygon"**.
* Show link to PolygonScan explorer: `https://amoy.polygonscan.com/tx/${tx_hash}`.

#### Case B: Revoked or Not Found (`404 Not Found`)
```json
{
  "success": false,
  "verified": false,
  "message": "Credential not found, revoked, or invalid on-chain."
}
```
* **UI Action:** Display red warning: **"Invalid or Revoked Credential"**.

#### Case C: Altered / Tampered Record (`200 OK` with `verified: false`)
```json
{
  "success": true,
  "verified": false,
  "message": "Certificate hash mismatch. Credential data may have been altered."
}
```
* **UI Action:** Display amber/red warning: **"Tamper Alert: Off-chain record does not match blockchain hash"**.

---

## 5. Offline-First Storage Architecture (`FR-WAL-03`)

Pakistani migrant workers frequently present credentials at border controls, visa consulates, or rural hubs with zero cellular connectivity.

### 5.1 Storage Security Rules
1. **Never store raw unencrypted credentials in AsyncStorage:**
   * **iOS:** Use `react-native-keychain` or `expo-secure-store` (backed by iOS Keychain Services / Secure Enclave).
   * **Android:** Use `EncryptedSharedPreferences` (backed by Android Keystore with AES-256-GCM).
2. **Offline Visual Indication:**
   * When the device is offline, render a clean badge:
     ```text
     "Verified Offline • Last Confirmed: 21 Oct 2026, 02:30 PM"
     ```
   * The scannable QR code and dynamic PDF **must remain 100% functional offline** using the cached payload.

---

## 6. Mobile In-App QR Scanner (Verifier Mode, `FR-VER-01`)

If your mobile build includes a scanner tab for employers or inspectors:

### 6.1 Scanner Workflow
1. Open device camera via `react-native-vision-camera` or `expo-camera`.
2. Extract the payload string from scanned QR.
3. Parse the `credentialId`:
   ```ts
   export function parseQrPayload(scannedText: string): string | null {
     try {
       // Case 1: Scanned a full verification URL
       if (scannedText.startsWith('http://') || scannedText.startsWith('https://')) {
         const url = new URL(scannedText);
         const id = url.searchParams.get('id');
         if (id && id.startsWith('urn:uuid:')) {
           return id;
         }
       }
       // Case 2: Scanned raw URN string
       if (scannedText.startsWith('urn:uuid:')) {
         return scannedText;
       }
     } catch {}
     return null;
   }
   ```
4. Query the public endpoint: `GET /api/ledger/verify/${encodeURIComponent(credentialId)}`.
5. Display full cryptographic verification receipt.

---

## 7. Complete Mobile Service Implementation (TypeScript / React Native)

Here is the drop-in networking and storage module for the mobile application:

```ts
// src/services/walletService.ts

const API_BASE_URL = 'https://api.nsp.gov.pk'; // Or your backend host

export interface VerificationResult {
  isValid: boolean;
  credentialId?: string;
  issuedAt?: string;
  onChainHash?: string;
  errorMessage?: string;
}

export const WalletService = {
  /**
   * Public on-chain verification call.
   * Completely unauthenticated (no headers, tokens, or cookies required).
   */
  async verifyCredentialOnChain(credentialId: string): Promise<VerificationResult> {
    try {
      const encodedId = encodeURIComponent(credentialId.trim());
      const response = await fetch(`${API_BASE_URL}/api/ledger/verify/${encodedId}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      const json = await response.json();

      if (response.ok && json.success && json.verified && json.data) {
        return {
          isValid: true,
          credentialId: json.data.credentialId,
          issuedAt: json.data.issuedAt,
          onChainHash: json.data.onChainHash,
        };
      }

      return {
        isValid: false,
        errorMessage: json.message || 'Credential not verified on-chain.',
      };
    } catch (error: any) {
      return {
        isValid: false,
        errorMessage: error?.message || 'Network connection failed.',
      };
    }
  },

  /**
   * Generates canonical URL for QR presentation
   */
  getQrVerificationUrl(credentialId: string): string {
    return `https://verifier.nsp.gov.pk/verify?id=${encodeURIComponent(credentialId)}`;
  },

  /**
   * Parses scanned QR content back into canonical credential ID
   */
  extractCredentialId(qrText: string): string | null {
    if (!qrText) return null;
    const trimmed = qrText.trim();

    if (trimmed.startsWith('urn:uuid:')) {
      return trimmed;
    }

    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        const id = url.searchParams.get('id');
        if (id && id.startsWith('urn:uuid:')) {
          return id;
        }
      }
    } catch {}

    return null;
  },
};
```

---

## 8. Mobile Dev Integration Checklist

- [ ] **1. Offline Storage Setup:** Implement encrypted local caching using `react-native-keychain` / `expo-secure-store`.
- [ ] **2. QR Code Display:** Implement QR code component rendering `WalletService.getQrVerificationUrl(credential_id)`.
- [ ] **3. Background Status Check:** Add network listener (`@react-native-community/netinfo`) to trigger `WalletService.verifyCredentialOnChain()` whenever connectivity returns.
- [ ] **4. Camera Scanner:** Wire camera QR scanner using `WalletService.extractCredentialId()`.
- [ ] **5. Zero-Auth Compliance:** Ensure no staff login, MFA, or laptop fingerprint headers are configured in the mobile wallet networking layer.
