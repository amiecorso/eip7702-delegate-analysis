## EIP-7702 unsafe delegation scan + verification

This directory contains several scripts (Bun + Node):

- `scan.ts`: uses Hypersync to find EOAs that submitted EIP-7702 transactions authorizing delegation to a target (unsafe CBSW implementation), then buckets them by whether they emitted `AddOwner`.
- `verify-current-state.ts`: uses JSON-RPC to check whether those EOAs are **still** delegated to one of the targets *right now*, and fetches ETH + USDC balances.
- `scan-type4-authorities.ts`: uses Hypersync to find **EIP-7702 type-4 transactions** and emits a deduped list of candidate “authority” EOAs for follow-on analysis.
- `scan-type4-authorities.mjs`: Node.js runner for the same scan, using Hypersync `get()` pagination. Use this if Bun crashes with a `trace trap`.
- `market-share.ts`: uses JSON-RPC to compute **current delegation market share** (by parsing `eth_getCode` delegation designator `0xef0100 + <delegate address>`) and ranks delegates, including an optional Coinbase delegate address.

### Setup

- Install dependencies:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
npm install --no-audit --no-fund
```

- Provide your Hypersync API key:

```bash
export HYPERSYNC_API_KEY="..."
```

### Run

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
bun run scan.ts
```

## Current market share prototype (Base)

This computes “market share” as: **# of EOAs that are currently delegated to each delegate address**, where “currently delegated” is detected by `eth_getCode(address, "latest")` starting with `0xef0100`.

## Methodology & rationale (why this repo exists)

### Why not just do this in Dune?

We care about **current** EIP-7702 delegation market share: “as of now, which delegate address does each EOA point to?”

Dune is excellent for historical analysis over indexed tables (transactions/logs), but this analysis needs a **state read** at scale:
- For each candidate EOA, fetch **current bytecode** (`eth_getCode(..., "latest")`) and parse the EIP-7702 designator `0xef0100 + <delegate>`.

That “current bytecode for arbitrary addresses” step is the crux of “current market share”, and it’s not something you can reliably/cheaply do purely via SQL over historical tables without either:
- maintaining your own state snapshot table, or
- approximating “current” via “latest type-4 tx per authority”.
+
The “latest type-4 tx per authority” shortcut is tempting, but it is not a clean substitute for current state unless you can prove that the latest authorization tuple was actually **valid and applied** under EIP-7702 rules (signature recovery, nonce match, chainId rules, ordering/duplicates within a tx, etc.). In other words: it’s easy to find “latest attempted authorization”, but harder to prove “latest applied authorization” from transaction data alone. Reading `eth_getCode(..., "latest")` sidesteps this ambiguity and tells you the ground-truth current delegate.

### Overall technique (Base-first, chain-by-chain)

This repo implements a two-phase pipeline:

1) **Discover the candidate EOAs that ever used EIP-7702 on the chain**
   - Scan for **type-4 transactions** (EIP-7702) and read the transaction `authorizationList`.
   - For each authorization tuple, recover the **authority EOA** (the signer), then dedupe authorities into a single address list.

2) **Compute current delegate market share from state**
   - For each authority EOA, call `eth_getCode(address, "latest")`.
   - If code starts with `0xef0100`, extract the 20-byte delegate address.
   - Aggregate counts by delegate address; rank delegates; optionally highlight Coinbase’s delegate.

### The hard/slow part: authority recovery (why scanning is expensive)

In a sponsored/relayed flow, `tx.from` can be a relayer and **is not guaranteed** to be the delegated EOA.
The delegated EOA is the **authorization signer (“authority”)** recovered from the tuple signature.

Hypersync returns authorization tuples containing the signature material:
- `chainId`, `address` (delegate target), `nonce`, `yParity`, `r`, `s`

Per EIP-7702, for each tuple:
- \(digest = keccak256(0x05 \,\|\, rlp([chainId, delegateAddress, nonce]))\)
- \(authority = ecrecover(digest, yParity, r, s)\)

That means millions of **secp256k1 recover** operations, which is CPU-heavy and often the dominant runtime.

### What the final output tells you (and what it doesn’t)

The market share output answers:
- **Among EOAs that have ever used type-4 on Base, how many are currently delegated to each delegate address?**
- Coinbase delegate rank/share on Base (if provided).

Important caveats:
- The candidate set is “ever observed type-4 on-chain” (per scan window). If you scan from the chain’s EIP-7702 activation block to head, this is the correct universe for that chain.
- This is **current** state: it intentionally ignores historical delegates that are no longer active.

### Operational notes

- **Hypersync vs Bun**: in some environments the Hypersync client can crash under Bun. If you see `trace trap`, use the Node runner `scan-type4-authorities.mjs` (`npm run scan:type4:node`).
- **RPC limits**: `eth_getCode` over millions of addresses will hit provider throttling. `market-share.ts` includes retries/backoff, chunking, progress logs, and checkpoint-based resume to make long runs practical.

### 1) Scan for candidate EOAs (Hypersync)

This step streams **type-4 transactions** and writes a deduped candidate list:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export HYPERSYNC_API_KEY="..."
export CHAIN=base
export FROM_BLOCK=13514406
bun run scan-type4-authorities.ts
```

If Bun crashes (e.g. `zsh: trace trap`), run the Node.js version:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export HYPERSYNC_API_KEY="..."
export CHAIN=base
export FROM_BLOCK=13514406
export TO_BLOCK=""
export OUTPUT_PREFIX="base-authority-fixed"
export RESUME=true
export HYPERSYNC_REQUEST_DELAY_MS=200
npm run scan:type4:node
```

Outputs (Base defaults to unprefixed):
- `type4-authority-addresses.txt` (or `<chain>-type4-authority-addresses.txt`)

#### Inspect Hypersync authorizationList “shape” (quick sample)

To print a few `authorizationList[0]` objects (keys + JSON) without doing a full scan:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export HYPERSYNC_API_KEY="..."
export CHAIN=base
export FROM_BLOCK=13514406
export TO_BLOCK=13515406
export DEBUG_SAMPLE=true
export DEBUG_SAMPLE_LIMIT=3
export SKIP_DOTENV=true
bun run scan-type4-authorities.ts
```

If you want to scan forward until you find samples (instead of capping by `TO_BLOCK`), set an empty `TO_BLOCK`.
This is more reliable than `unset TO_BLOCK` if you have a `.env` file or Bun dotenv auto-loading:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export HYPERSYNC_API_KEY="..."
export CHAIN=base
export FROM_BLOCK=13514406
export TO_BLOCK=""
export DEBUG_SAMPLE=true
export DEBUG_SAMPLE_LIMIT=3
export SKIP_DOTENV=true
bun run scan-type4-authorities.ts
```

If you hit transient Hypersync rate limits/timeouts on large scans, try lowering Hypersync's internal stream concurrency:

```bash
export HYPERSYNC_STREAM_CONCURRENCY=1
export HYPERSYNC_BATCH_SIZE=5000
export HYPERSYNC_MAX_BATCH_SIZE=20000
```

Notes:
- `scan-type4-authorities.ts`/`.mjs` recover the **authority** (signer) from each EIP-7702 authorization tuple (`yParity/r/s`), which is required for correctness when transactions are sponsored/relayed.
- There is a fallback to `tx.from` only if signature recovery fails for a given tuple (should be rare).

### 2) Compute current delegate market share (RPC)

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export RPC_URL_BASE="..."
export COINBASE_DELEGATE_ADDRESS="0x..."
export CHAIN=base
export CONCURRENCY=16
bun run market-share.ts
```

Outputs:
- `<chain>-delegate-market-share.json`
- `<chain>-delegate-market-share.csv`

If you hit RPC rate limits (HTTP 429), `market-share.ts` retries with exponential backoff.
You can further throttle if needed:

```bash
export RPC_MAX_RETRIES=8
export RPC_REQUEST_DELAY_MS=0          # add a small delay (e.g. 25-100) if needed
export RPC_RETRY_BASE_DELAY_MS=250
export RPC_RETRY_MAX_DELAY_MS=10000
```

To make long runs observable and resumable:

```bash
export OUTPUT_DIR="results/$(date +%Y-%m-%d_%H%M%S)/market-share"
export CHUNK_SIZE=25000
export PROGRESS_EVERY_MS=10000
export RESUME=true
```

This will write a checkpoint file:
- `<chain>-delegate-market-share.checkpoint.json` (in `OUTPUT_DIR`)

## Render a simple HTML report (pie + bar charts)

Once you have `<chain>-delegate-market-share.json`, you can render a single HTML report:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export INPUT_JSON="results/<timestamp>/market-share/base-delegate-market-share.json"
export OUTPUT_DIR="results/<timestamp>/market-share"
export OUTPUT_FILE="base-delegate-market-share-report.html"
export TOP_N=15
export BAR_N=30
npm run report
```

Then open `base-delegate-market-share-report.html` in your browser.

## Label mapping + aggregated (“by wallet”) view

We store a best-effort delegate label mapping locally:
- `labels/wintermute-custom-labels.sql` (source: [Dune query 5145294](https://dune.com/queries/5145294))
- `labels/wintermute-custom-labels.json` (normalized JSON used by scripts)

To aggregate the raw delegate market share into a “by wallet” view using this mapping:

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
export INPUT_JSON="results/<timestamp>/market-share/base-delegate-market-share.json"
export LABELS_JSON="labels/wintermute-custom-labels.json"
export OUTPUT_DIR="results/<timestamp>/market-share"
export UNLABELED_MODE=group   # group | keep
npm run aggregate:labels
```

This produces:
- `base-delegate-market-share-by-wallet.json`
- `base-delegate-market-share-by-wallet.csv`

You can then point `INPUT_JSON` at the aggregated JSON and re-run `npm run report` to render charts for the aggregated view.

### Running on other chains

By default, this runs against Base (`https://base.hypersync.xyz`).

You can run against other chains by setting either:
- `CHAIN` (builds `https://${CHAIN}.hypersync.xyz`), or
- `HYPERSYNC_URL` (full override)

Example (Optimism):

```bash
export CHAIN=optimism
export FROM_BLOCK=0
export TARGET_ADDRESSES="0x...,0x..."   # if you want multiple targets
export SKIP_FETCH_TRANSACTIONS=false
bun run scan.ts
```

Outputs are prefixed by `OUTPUT_PREFIX` (defaults to `CHAIN` when set). For Base, if you don’t set `CHAIN` or `OUTPUT_PREFIX`, files are **unprefixed** for convenience/compatibility.

### Outputs

- `from-addresses.txt` (Base) or `<chain>-from-addresses.txt`: unique `from` addresses for matching type-4 transactions
- `delegated-addresses.txt` (Base) or `<chain>-delegated-addresses.txt`: normalized copy of the full delegated set
- `delegated-with-addowner.txt` (Base) or `<chain>-delegated-with-addowner.txt`: subset that emitted AddOwner
- `delegated-without-addowner.txt` (Base) or `<chain>-delegated-without-addowner.txt`: subset with no AddOwner observed
- `addowner-check-results.json`: summary + per-address AddOwner matches (overwritten each run)

### Important env vars (scan)

- `HYPERSYNC_API_KEY` (required)
- `CHAIN` or `HYPERSYNC_URL` (optional; defaults to Base)
- `FROM_BLOCK` (optional)
- `TARGET_ADDRESSES` (optional; defaults to the two CBSW impl addresses)
- `SKIP_FETCH_TRANSACTIONS=true` to reuse the existing `from-addresses.txt` file for the current prefix/chain instead of re-scanning transactions

## Verify current delegation + balances (RPC)

`verify-current-state.ts` takes the delegated address lists you already generated (per chain) and, for each address:

- Reads current code via `eth_getCode` and checks for the EIP-7702 delegation designator `0xef0100 + <target address>`
- Fetches the current native balance via `eth_getBalance`
- Fetches USDC balance via `eth_call` to `balanceOf(address)` (if a USDC address is configured for that chain)

### Required env

You must provide an RPC URL per chain, for example:

```bash
export RPC_URL_BASE="..."
export RPC_URL_ARBITRUM="..."
export RPC_URL_OPTIMISM="..."
export RPC_URL_ETH="..."
```

Optional overrides:

- `TARGET_ADDRESSES`: comma-separated targets to treat as “unsafe” (defaults to the two CBSW impl addresses)
- `USDC_ADDRESS_<CHAIN>`: override the USDC contract address per chain (e.g. `USDC_ADDRESS_ZORA=0x...`)
- `CHAINS`: comma-separated list to limit which chains to process (otherwise auto-detect from output files)
- `OUTPUT_DIR`: directory containing the delegated-addresses output files (defaults to `.`)
- `CONCURRENCY`: number of concurrent RPC requests (default `8`)
- `ONLY_WITHOUT_ADDOWNER=true`: only verify addresses from the `*-delegated-without-addowner.txt` lists

### Run

```bash
cd /Users/amiecorso/smart-wallet/tools/eip7702-unsafe-delegations
bun run verify-current-state.ts
```

### Outputs

In the output directory (default current directory):

- `<chain>-current-state.json`
- `<chain>-current-state.csv`
- `current-state-all-chains.json`

Balance fields in JSON/CSV:
- `ethBalanceEth` (human-readable ETH) and `ethBalanceWei` (raw)
- `usdcBalance` (human-readable) and `usdcBalanceRaw` (raw)

