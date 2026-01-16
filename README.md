## EIP-7702 unsafe delegation scan + verification

This directory contains two Bun scripts:

- `scan.ts`: uses Hypersync to find EOAs that submitted EIP-7702 transactions authorizing delegation to a target (unsafe CBSW implementation), then buckets them by whether they emitted `AddOwner`.
- `verify-current-state.ts`: uses JSON-RPC to check whether those EOAs are **still** delegated to one of the targets *right now*, and fetches ETH + USDC balances.

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

