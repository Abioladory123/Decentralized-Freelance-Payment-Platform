# Stellar Freelance Payment Platform: API Integration Guide

This guide walks third-party developers, DAOs, mobile clients, and automation bots through integrating with the Stellar Freelance Payment Platform.

---

## Architecture Overview

The platform uses a **non-custodial hybrid architecture**:

```
+-------------------------------------------------------------------------+
|                              CLIENT / BOT                               |
|   (Holds Stellar Private Keys, Signs Challenges & Soroban Transactions) |
+-----------------------+-------------------------+-----------------------+
                        |                         |
            1. REST API Requests      3. Submit Signed XDR
                        |                         |
                        v                         v
        +-------------------------------+   +-----------------------------+
        |         BACKEND API           |   |     STELLAR TESTNET /       |
        |  - Issues SEP-53 Challenges   |   |     SOROBAN RPC             |
        |  - Issues JWT Session Tokens  |   |  - Simulates & Executes Tx  |
        |  - Builds Unsigned XDR        |   |  - Emits Contract Events    |
        |  - Indexes Chain Events to DB |   +--------------+--------------+
        +---------------+---------------+                  |
                        |                                  |
                        +-------- 4. Ingest Events <-------+
```

1. **Backend holds no private keys:** The backend only constructs unsigned transaction envelopes (XDR).
2. **Client-side signing:** Your client or bot signs XDR envelopes locally with a Stellar keypair.
3. **Soroban RPC execution:** The signed transaction is submitted directly to the Stellar network (RPC/Horizon).
4. **State synchronization:** The backend event indexer automatically monitors the chain and updates job/escrow states.

---

## Authentication: SEP-53 Wallet Challenge

Authentication uses a challenge-nonce signature flow (SEP-53) and returns a short-lived Bearer JWT.

### Steps
1. Request a cryptographically secure nonce for your Stellar public key via `GET /api/users/challenge?address=<STELLAR_ADDRESS>`.
2. Sign the nonce with your private key using ed25519 raw signature.
3. Exchange the signature for a JWT via `POST /api/users/auth`.
4. Include the header `Authorization: Bearer <TOKEN>` in subsequent API requests.

### TypeScript Example (Node.js)

```typescript
import { Keypair } from "@stellar/stellar-sdk";

const API_BASE = "http://localhost:3000";
const keypair = Keypair.fromSecret("SD...YOUR_SECRET_KEY");

async function authenticate(): Promise<string> {
  // 1. Request nonce challenge
  const challengeRes = await fetch(
    `${API_BASE}/api/users/challenge?address=${keypair.publicKey()}`
  );
  if (!challengeRes.ok) throw new Error(`Challenge failed: ${await challengeRes.text()}`);
  const { nonce } = (await challengeRes.json()) as { nonce: string };

  // 2. Sign nonce with Keypair
  const signatureBytes = keypair.sign(Buffer.from(nonce, "utf-8"));
  const signature = signatureBytes.toString("base64");

  // 3. Authenticate and receive JWT
  const authRes = await fetch(`${API_BASE}/api/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stellarAddress: keypair.publicKey(),
      signature,
    }),
  });
  if (!authRes.ok) throw new Error(`Auth failed: ${await authRes.text()}`);
  const { token } = (await authRes.json()) as { token: string };

  return token;
}
```

### Python Example

```python
import base64
import requests
from stellar_sdk import Keypair

API_BASE = "http://localhost:3000"
keypair = Keypair.from_secret("SD...YOUR_SECRET_KEY")

def authenticate() -> str:
    # 1. Request nonce challenge
    res = requests.get(f"{API_BASE}/api/users/challenge", params={"address": keypair.public_key})
    res.raise_for_status()
    nonce = res.json()["nonce"]

    # 2. Sign nonce with Keypair
    signature_bytes = keypair.sign(nonce.encode("utf-8"))
    signature = base64.b64encode(signature_bytes).decode("utf-8")

    # 3. Authenticate and receive JWT
    auth_res = requests.post(
        f"{API_BASE}/api/users/auth",
        json={"stellarAddress": keypair.public_key, "signature": signature},
    )
    auth_res.raise_for_status()
    return auth_res.json()["token"]
```

---

## Creating a Job and Building Escrow XDR

### 1. Post Job Record (`POST /api/jobs`)
Create an off-chain job record specifying title, description, asset, and milestone breakdowns.

```json
{
  "title": "Smart Contract Integration Audit",
  "description": "Comprehensive audit of Soroban escrow and dispute contracts",
  "freelancer": "GA...FREELANCER_STELLAR_ADDRESS",
  "asset": "USDC",
  "milestones": [
    { "amount": "500.0", "description": "Phase 1: Static Analysis", "deadline": "2026-12-15T00:00:00.000Z" },
    { "amount": "1000.0", "description": "Phase 2: Formal Verification Report", "deadline": "2026-12-30T00:00:00.000Z" }
  ],
  "tags": ["blockchain", "security"]
}
```

### 2. Request Escrow Creation Transaction (`POST /api/escrow/build/create`)
Send the created job ID and timeout to generate an unsigned Soroban transaction envelope:

```json
{
  "jobId": "cuid_from_post_job",
  "freelancerAddress": "GA...FREELANCER_STELLAR_ADDRESS",
  "expiryTimestamp": 1735603200
}
```

Response:
```json
{
  "xdr": "AAAAAgAAAAD..."
}
```

---

## Submitting Signed XDR to Stellar Soroban RPC

Once you receive the unsigned XDR envelope:
1. Parse the transaction envelope with your Stellar SDK.
2. Sign the transaction using the client's keypair.
3. Submit the transaction to Soroban RPC via `sendTransaction`.
4. Poll `getTransaction` until status is `SUCCESS`.
5. Extract the returned `escrowId` and sync it with `POST /api/escrow/sync/:jobId`.

### TypeScript Example (Signing, Submitting, and Syncing)

```typescript
import {
  Keypair,
  TransactionBuilder,
  Networks,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";

const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const server = new SorobanRpc.Server(SOROBAN_RPC_URL);

async function signAndSubmitXdr(
  xdr: string,
  keypair: Keypair,
  jobId: string,
  token: string,
): Promise<string> {
  // 1. Decode transaction envelope
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);

  // 2. Sign transaction with client keypair
  tx.sign(keypair);

  // 3. Submit to Soroban RPC
  const sendResponse = await server.sendTransaction(tx);
  if (sendResponse.status === "ERROR") {
    throw new Error(`Transaction submission error: ${JSON.stringify(sendResponse)}`);
  }

  // 4. Poll for transaction confirmation
  let getTxResponse = await server.getTransaction(sendResponse.hash);
  while (getTxResponse.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getTxResponse = await server.getTransaction(sendResponse.hash);
  }

  if (getTxResponse.status !== "SUCCESS") {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(getTxResponse)}`);
  }

  // 5. ParseReturnValue to extract escrowId (u64)
  const returnValue = getTxResponse.returnValue;
  const escrowId = returnValue?.u64 ? Number(returnValue.u64()) : 0;

  // 6. Sync on-chain escrow id to backend job record
  await fetch(`${API_BASE}/api/escrow/sync/${jobId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ escrowId }),
  });

  return getTxResponse.txHash;
}
```

### Python Example

```python
import time
from stellar_sdk import Keypair, TransactionEnvelope, Network
from stellar_sdk.soroban_server import SorobanServer

SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org"
server = SorobanServer(SOROBAN_RPC_URL)

def sign_and_submit_xdr(xdr: str, keypair: Keypair, job_id: str, token: str) -> str:
    # 1. Decode envelope
    te = TransactionEnvelope.from_xdr(xdr, network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE)

    # 2. Sign envelope
    te.sign(keypair)

    # 3. Submit to Soroban RPC
    send_response = server.send_transaction(te)
    tx_hash = send_response.hash

    # 4. Poll until confirmed
    tx_response = server.get_transaction(tx_hash)
    while tx_response.status == "NOT_FOUND":
        time.sleep(1)
        tx_response = server.get_transaction(tx_hash)

    if tx_response.status != "SUCCESS":
        raise RuntimeError(f"Transaction failed on-chain: {tx_response}")

    # Extract escrow ID (defaulting to 0 for initial deployment if not parsed)
    escrow_id = 0

    # 5. Sync escrow ID with backend
    sync_res = requests.post(
        f"{API_BASE}/api/escrow/sync/{job_id}",
        headers={"Authorization": f"Bearer {token}"},
        json={"escrowId": escrow_id},
    )
    sync_res.raise_for_status()

    return tx_hash
```

---

## Escrow Lifecycle Operations

All state-modifying escrow operations follow the same pattern:
1. Call the backend API route with authentication to obtain unsigned XDR.
2. Sign the XDR envelope locally.
3. Submit the signed transaction to Soroban RPC.

| Action | Route | Body | Description |
|---|---|---|---|
| **Fund Escrow** | `POST /api/escrow/build/fund` | `{"escrowId": 0}` | Transfers milestone tokens into the escrow contract |
| **Release Milestone** | `POST /api/escrow/build/release` | `{"escrowId": 0, "milestoneIndex": 0}` | Releases milestone payment to freelancer |
| **Raise Dispute** | `POST /api/disputes` | `{"escrowId": 0, "reason": "Work did not match spec"}` | Freezes escrow and initiates arbitrator dispute |
| **Reclaim Expired** | `POST /api/escrow/build/reclaim` | `{"escrowId": 0}` | Refunds client after expiry timestamp has passed |
| **Reclaim Dispute** | `POST /api/escrow/build/reclaim-dispute` | `{"escrowId": 0}` | Refunds client if arbitrator panel stalls past 7-day timelock |

---

## Querying Receipts and Transaction History (with HTTP Caching)

The platform provides cached, deterministic endpoints with `ETag` and `Cache-Control: public, max-age=300, stale-while-revalidate=60` headers.

### Escrow Receipt (`GET /api/escrow/:escrowId/receipt`)
Provides full immutable receipt of milestones, approvals, releases, and transaction hashes:

```bash
# Initial Request (200 OK with ETag)
curl -i http://localhost:3000/api/escrow/0/receipt

# Conditional Revalidation Request (304 Not Modified)
curl -i -H 'If-None-Match: W/"32a-K4j2..."' http://localhost:3000/api/escrow/0/receipt
```

### Historical Transactions (`GET /api/users/:address/transactions`)
Returns paginated list of on-chain operations (funded, released, disputed, resolved, refunded) with explorer transaction hashes:

```bash
curl "http://localhost:3000/api/users/GA.../transactions?page=1&limit=20"
```

---

## Complete End-to-End TypeScript Client Example

Save as `integration_demo.ts` and run with `npx tsx integration_demo.ts`:

```typescript
import { Keypair, TransactionBuilder, Networks, rpc as SorobanRpc } from "@stellar/stellar-sdk";

const API_BASE = "http://localhost:3000";
const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new SorobanRpc.Server(RPC_URL);

// Testnet Keypair (Client)
const clientKeypair = Keypair.random();
const freelancerKeypair = Keypair.random();

async function main() {
  console.log("1. Authenticating client:", clientKeypair.publicKey());
  
  // Step 1: Request Challenge
  const chRes = await fetch(`${API_BASE}/api/users/challenge?address=${clientKeypair.publicKey()}`);
  const { nonce } = await chRes.json();
  const signature = clientKeypair.sign(Buffer.from(nonce, "utf-8")).toString("base64");

  // Step 2: Acquire JWT Token
  const authRes = await fetch(`${API_BASE}/api/users/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stellarAddress: clientKeypair.publicKey(), signature }),
  });
  const { token } = await authRes.json();
  console.log("JWT acquired successfully.");

  // Step 3: Create Job
  const jobRes = await fetch(`${API_BASE}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: "Fullstack DApp Integration",
      description: "Build frontend client with wallet connector",
      freelancer: freelancerKeypair.publicKey(),
      asset: "USDC",
      milestones: [{ amount: "100.0", description: "Milestone 1" }],
    }),
  });
  const job = await jobRes.json();
  console.log("Job created with ID:", job.id);

  // Step 4: Build Escrow Create XDR
  const escrowRes = await fetch(`${API_BASE}/api/escrow/build/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jobId: job.id,
      freelancerAddress: freelancerKeypair.publicKey(),
      expiryTimestamp: Math.floor(Date.now() / 1000) + 86400 * 7,
    }),
  });
  const { xdr } = await escrowRes.json();
  console.log("Unsigned XDR generated successfully.");
  console.log("XDR Preview:", xdr.substring(0, 40) + "...");
}

main().catch(console.error);
```

---

## Best Practices & Operational Checklist

1. **Verify Contract IDs:** Ensure backend environment variables `ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, and `REPUTATION_CONTRACT_ID` match the active deployment in `deployments/testnet.json`.
2. **Handle Gateway Timeouts (504):** Database queries are governed by a 10-second statement timeout. Retry idempotent read requests with exponential backoff if a 504 status is returned.
3. **Respect Rate Limits:** Auth endpoints (`/challenge`, `/auth`) enforce a dedicated budget (default 10 requests/minute per IP). Cache JWT tokens until expiration rather than re-authenticating per request.
4. **Conditional Requests:** Always store and transmit `ETag` values via `If-None-Match` when polling receipts or static documents to avoid unnecessary data transfer.
