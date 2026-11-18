# Testnet deployment

The three contracts are deployed to Stellar **testnet** and initialized. These
are testnet-only deployments; never send real funds to them.

| Contract | Contract ID | Explorer |
|----------|-------------|----------|
| escrow | `CALNRFGMUI7MLNLWO445U2BSDENF6DENURHXXFFRT6PV5GSOQX7GZGP7` | https://lab.stellar.org/r/testnet/contract/CALNRFGMUI7MLNLWO445U2BSDENF6DENURHXXFFRT6PV5GSOQX7GZGP7 |
| dispute | `CB24TF5GPP7EA6VWK4KZWBHHSY6FWNV3DKOGSZSDK347EODGGNPN7IMF` | https://lab.stellar.org/r/testnet/contract/CB24TF5GPP7EA6VWK4KZWBHHSY6FWNV3DKOGSZSDK347EODGGNPN7IMF |
| reputation | `CA5GXR4LVH5DYGB2RZDFAM3VNJW6LQ5EKUKURSLZBJGAH7LFJAOHKSET` | https://lab.stellar.org/r/testnet/contract/CA5GXR4LVH5DYGB2RZDFAM3VNJW6LQ5EKUKURSLZBJGAH7LFJAOHKSET |

- **Network:** testnet (`Test SDF Network ; September 2015`)
- **Admin / arbitrator:** `GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B`
  (the panel is `init(admin=admin, arbitrators=[admin], threshold=1)`)
- **USDC contract:** *optional for local testing* — the default testnet setup
  uses the testnet native XLM SAC (`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`).
  To test USDC escrow payments, follow the [Mock USDC deployment guide](#mock-usdc-deployment--sac-wrapping) below.

> These ids are from the most recent deploy and are replaced whenever the
> contracts change. `scripts/deploy_testnet.sh` rewrites `deployments/testnet.json`,
> `frontend/.env` and `backend/.env.contracts`, and prints the values for the
> deployed backend, so re-run it instead of hand-editing any of them. The API
> warns at startup when its configured ids no longer match the record (issue #91).
- The machine-readable record lives in [`../deployments/testnet.json`](../deployments/testnet.json).

## Mock USDC deployment & SAC wrapping

### What is Stellar Asset Contract (SAC) wrapping?
Classic Stellar assets (identified as `<AssetCode>:<IssuerAddress>`) and native XLM live on the classic Stellar ledger. To interact with Soroban smart contracts (such as our `escrow` contract), classic assets are wrapped by the **Stellar Asset Contract (SAC)**.

The SAC:
- Exposes standard Soroban SEP-41 token methods: `name()`, `symbol()`, `decimals()` (always 7 for classic Stellar assets), `balance(id)`, `transfer(from, to, amount)`, and `mint(to, amount)`.
- Directly unifies Soroban token balances with classic Stellar trustline balances on ledger.
- For native XLM, the testnet SAC ID is deterministic: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.
- For mock USDC, an issuer keypair issues classic `USDC:<issuer_address>`, and `stellar contract asset deploy` installs its SAC wrapper.

### Step-by-step: Deploy & mint mock USDC on Testnet

#### 1. Generate and fund the USDC issuer account
```bash
stellar keys generate usdc-issuer --network testnet --fund
ISSUER_ADDRESS="$(stellar keys address usdc-issuer)"
echo "USDC Issuer Address: $ISSUER_ADDRESS"
```

#### 2. Deploy the Stellar Asset Contract (SAC) for USDC
```bash
USDC_CONTRACT_ID="$(stellar contract asset deploy \
  --asset "USDC:$ISSUER_ADDRESS" \
  --source usdc-issuer \
  --network testnet)"
echo "USDC SAC Contract ID: $USDC_CONTRACT_ID"
```
*(Tip: You can also query the deterministic contract ID at any time via `stellar contract id asset --asset "USDC:$ISSUER_ADDRESS" --network testnet`)*

#### 3. Mint mock USDC to developer / client accounts
Only the issuer account can invoke `mint`. Amounts are in base units (7 decimals, so 1,000 USDC = `10000000000` base units):
```bash
CLIENT_ADDRESS="$(stellar keys address deployer)"

# Mint 1,000 USDC to client
stellar contract invoke \
  --id "$USDC_CONTRACT_ID" \
  --source usdc-issuer \
  --network testnet \
  -- mint \
  --to "$CLIENT_ADDRESS" \
  --amount 10000000000

# Verify client balance
stellar contract invoke \
  --id "$USDC_CONTRACT_ID" \
  --source deployer \
  --network testnet \
  -- balance \
  --id "$CLIENT_ADDRESS"
```

#### 4. Configure environment and deployment records
Save the resulting contract ID so the frontend, backend, and scripts recognize USDC:
- In `deployments/testnet.json`: Set `"usdc_contract_id": "<USDC_CONTRACT_ID>"`.
- In `frontend/.env`: Set `VITE_USDC_CONTRACT_ID=<USDC_CONTRACT_ID>`.
- In `backend/.env` and `backend/.env.contracts`: Set `USDC_CONTRACT_ID=<USDC_CONTRACT_ID>`.

Or pass it directly when re-running deployment:
```bash
USDC_CONTRACT_ID="$USDC_CONTRACT_ID" scripts/deploy_testnet.sh
```

## Reproduce the deployment

Prerequisites: `stellar-cli` v25.2.0+ (v28 current) and Rust stable with the
`wasm32v1-none` target.

```bash
rustup target add wasm32v1-none
stellar keys generate deployer --network testnet --fund

# Builds, deploys, initializes all three contracts, and writes
# deployments/testnet.json + frontend/.env + backend/.env.contracts
scripts/deploy_testnet.sh
```

## Reproduce the end-to-end flow

```bash
scripts/demo_testnet.sh
```

The demo runs `create → fund → release all milestones → status Completed →
submit rating → get_aggregate`, printing the transaction results. It uses the
testnet XLM SAC by default; pass `TOKEN_CONTRACT_ID=<sac>` to use another asset.

The dispute path (`open_dispute → raise → approve → arbitrate`) has its own
demo, which asserts the escrow ends `Completed` and the dispute `Resolved`:

```bash
scripts/demo_dispute_testnet.sh
```

## A note on builds (Soroban SDK v28+)

Soroban SDK v28+ requires:
- the **`wasm32v1-none`** target (not `wasm32-unknown-unknown`), and
- building via **`stellar contract build`** (the SDK build script refuses a
  plain `cargo build` for the wasm target).

Wasm artifacts land in `contracts/target/wasm32v1-none/release/`.
