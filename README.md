## EIP-7702 unsafe delegation scan (Base)

This is a small Bun script that uses Hypersync to:

- Find EOAs that submitted EIP-7702 transactions authorizing delegation to a specific target address
- (Optionally) check whether those addresses later emitted the `AddOwner` event

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
bun run scan
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

Outputs are prefixed by `OUTPUT_PREFIX` (defaults to `CHAIN`, otherwise `base`) so you can run multiple chains without clobbering files.

### Outputs

- `<prefix>-from-addresses.txt`: unique `from` addresses for matching type-4 transactions
- `<prefix>-delegated-addresses.txt`: normalized copy of the full delegated set
- `<prefix>-delegated-with-addowner.txt`: subset that emitted AddOwner
- `<prefix>-delegated-without-addowner.txt`: subset with no AddOwner observed
- `addowner-check-results.json`: summary + per-address AddOwner matches

