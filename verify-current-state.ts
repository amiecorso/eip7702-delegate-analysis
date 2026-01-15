import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnvIfPresent(envPath = ".env") {
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const withoutExport = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length).trim()
        : trimmed;

      const eq = withoutExport.indexOf("=");
      if (eq === -1) continue;

      const key = withoutExport.slice(0, eq).trim();
      if (!key) continue;

      let value = withoutExport.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // ignore
  }
}

type ChainConfig = {
  chain: string;
  rpcUrl: string;
  usdcAddress?: string;
  usdcDecimals: number;
};

type AddressResult = {
  address: string;
  code: string;
  isDelegatedToTarget: boolean;
  delegatedTarget?: string;
  ethBalanceEth: string;
  ethBalanceWei: string;
  usdcBalance?: string;
  usdcBalanceRaw?: string;
};

const EIP7702_PREFIX = "0xef0100";
const DEFAULT_TARGET_ADDRESSES =
  "0x000100abaad02f1cfC8Bbe32bD5a564817339E72,0x00000110dCdEdC9581cb5eCB8467282f2926534d";

const targetAddresses = (process.env.TARGET_ADDRESSES ?? DEFAULT_TARGET_ADDRESSES)
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

const DEFAULT_USDC_BY_CHAIN: Record<string, { address: string; decimals: number }> =
  {
    // Mainnets/L2s (best-effort defaults; can be overridden via USDC_ADDRESS_<CHAIN>)
    base: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    optimism: { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6 },
    arbitrum: { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
    eth: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 },
    polygon: { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6 },
    avalanche: { address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6 },
    bsc: { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18 }, // BSC USDC is 18 decimals
    // zora intentionally omitted (set via env if needed)
  };

function envKeyForChain(prefix: string, chain: string) {
  return `${prefix}_${chain.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function getChainConfig(chain: string): ChainConfig | null {
  const rpcUrl =
    process.env[envKeyForChain("RPC_URL", chain)] ??
    (process.env.CHAIN === chain ? process.env.RPC_URL : undefined);

  if (!rpcUrl) return null;

  const usdcOverride = process.env[envKeyForChain("USDC_ADDRESS", chain)];
  const defaults = DEFAULT_USDC_BY_CHAIN[chain];
  const usdcAddress = usdcOverride ?? defaults?.address;
  const usdcDecimals = defaults?.decimals ?? 6;

  return { chain, rpcUrl, usdcAddress, usdcDecimals };
}

function parseAddressesFile(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const addrs = raw
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(addrs)).sort();
}

function findChainsFromOutputs(dir: string): Record<string, string> {
  const entries = readdirSync(dir);
  const out: Record<string, string> = {};

  // base: allow either unprefixed or prefixed (base-*) for convenience.
  const baseCandidates = [
    "delegated-addresses.txt",
    "from-addresses.txt",
    "base-delegated-addresses.txt",
    "base-from-addresses.txt",
  ];
  for (const name of baseCandidates) {
    if (entries.includes(name)) {
      out["base"] = join(dir, name);
      break;
    }
  }

  for (const name of entries) {
    const mDelegated = name.match(/^(.+)-delegated-addresses\.txt$/);
    if (mDelegated) {
      out[mDelegated[1]] = join(dir, name);
      continue;
    }

    const mFrom = name.match(/^(.+)-from-addresses\.txt$/);
    if (mFrom) {
      // Only use from-addresses if we don't have delegated-addresses for that chain.
      out[mFrom[1]] ??= join(dir, name);
      continue;
    }
  }

  return out;
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  id: number,
): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

function toPaddedAddressArg(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, "");
  return a.padStart(64, "0");
}

function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? `.${fracStr}` : ""}`;
}

function detectDelegationTarget(code: string): string | undefined {
  const c = code.toLowerCase();
  if (!c.startsWith(EIP7702_PREFIX)) return undefined;
  const rest = c.slice(EIP7702_PREFIX.length);
  for (const target of targetAddresses) {
    const t = target.replace(/^0x/, "");
    if (rest.startsWith(t)) return target;
  }
  return undefined;
}

async function checkOneAddress(
  cfg: ChainConfig,
  address: string,
  idBase: number,
): Promise<AddressResult> {
  const [code, ethBal] = await Promise.all([
    rpcCall<string>(cfg.rpcUrl, "eth_getCode", [address, "latest"], idBase + 1),
    rpcCall<string>(cfg.rpcUrl, "eth_getBalance", [address, "latest"], idBase + 2),
  ]);

  const delegatedTarget = detectDelegationTarget(code);
  const isDelegatedToTarget = delegatedTarget !== undefined;

  let usdcBalanceRaw: string | undefined;
  if (cfg.usdcAddress) {
    const data = "0x70a08231" + toPaddedAddressArg(address);
    try {
      usdcBalanceRaw = await rpcCall<string>(
        cfg.rpcUrl,
        "eth_call",
        [{ to: cfg.usdcAddress, data }, "latest"],
        idBase + 3,
      );
    } catch {
      // ignore missing token / unsupported chain / RPC limitations
    }
  }

  const ethBalanceWeiBig = BigInt(ethBal);
  const ethBalanceEth = formatUnits(ethBalanceWeiBig, 18);

  const usdcBalance =
    usdcBalanceRaw !== undefined
      ? formatUnits(BigInt(usdcBalanceRaw), cfg.usdcDecimals)
      : undefined;

  return {
    address,
    code,
    isDelegatedToTarget,
    delegatedTarget,
    ethBalanceEth,
    ethBalanceWei: ethBal,
    usdcBalance,
    usdcBalanceRaw,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function findChainsFromWithoutAddOwnerOutputs(dir: string): Record<string, string> {
  const entries = readdirSync(dir);
  const out: Record<string, string> = {};

  // base: allow either unprefixed or prefixed (base-*) for convenience.
  const baseCandidates = [
    "delegated-without-addowner.txt",
    "base-delegated-without-addowner.txt",
  ];
  for (const name of baseCandidates) {
    if (entries.includes(name)) {
      out["base"] = join(dir, name);
      break;
    }
  }

  for (const name of entries) {
    const m = name.match(/^(.+)-delegated-without-addowner\.txt$/);
    if (!m) continue;
    out[m[1]] = join(dir, name);
  }

  return out;
}

async function main() {
  loadDotEnvIfPresent();

  const configuredDir = process.env.OUTPUT_DIR ?? ".";
  const cwdDir = ".";
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));

  const candidateDirs = Array.from(
    new Set([configuredDir, cwdDir, scriptDir].filter(Boolean)),
  );

  const onlyWithoutAddOwner = process.env.ONLY_WITHOUT_ADDOWNER === "true";

  let dir = configuredDir;
  let chainsToFile: Record<string, string> = {};

  for (const d of candidateDirs) {
    chainsToFile = onlyWithoutAddOwner
      ? findChainsFromWithoutAddOwnerOutputs(d)
      : findChainsFromOutputs(d);
    if (Object.keys(chainsToFile).length > 0) {
      dir = d;
      break;
    }
  }

  const onlyChains = (process.env.CHAINS ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const chains = Object.keys(chainsToFile)
    .filter((c) => (onlyChains.length ? onlyChains.includes(c) : true))
    .sort((a, b) => (a === "base" ? -1 : b === "base" ? 1 : a.localeCompare(b)));

  if (chains.length === 0) {
    throw new Error(
      `No input address files found. cwd=${process.cwd()} searched=${candidateDirs.join(
        ",",
      )} expected ${
        onlyWithoutAddOwner
          ? "delegated-without-addowner.txt and/or <chain>-delegated-without-addowner.txt"
          : "delegated-addresses.txt and/or <chain>-delegated-addresses.txt"
      }`,
    );
  }

  const concurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 8;

  const combined: Record<string, { config?: ChainConfig; results: AddressResult[] }> =
    {};

  for (const chain of chains) {
    const cfg = getChainConfig(chain);
    if (!cfg) {
      console.warn(
        `Skipping ${chain}: missing RPC URL env (set ${envKeyForChain("RPC_URL", chain)} or RPC_URL with CHAIN=${chain})`,
      );
      continue;
    }

    const addresses = parseAddressesFile(chainsToFile[chain]);
    console.log(`\n[${chain}] checking ${addresses.length} addresses...`);

    const results = await mapWithConcurrency(addresses, concurrency, (addr, i) =>
      checkOneAddress(cfg, addr, i * 10),
    );

    combined[chain] = { config: cfg, results };

    const jsonOut = join(dir, `${chain}-current-state.json`);
    writeFileSync(jsonOut, JSON.stringify({ chain, config: cfg, results }, null, 2));

    const csvOut = join(dir, `${chain}-current-state.csv`);
    const header =
      "address,is_delegated_to_target,delegated_target,eth_balance_eth,eth_balance_wei,usdc_balance,usdc_balance_raw\n";
    const lines = results.map((r) => {
      return [
        r.address,
        r.isDelegatedToTarget ? "true" : "false",
        r.delegatedTarget ?? "",
        r.ethBalanceEth,
        r.ethBalanceWei,
        r.usdcBalance ?? "",
        r.usdcBalanceRaw ?? "",
      ].join(",");
    });
    writeFileSync(csvOut, header + lines.join("\n") + "\n");

    const stillDelegated = results.filter((r) => r.isDelegatedToTarget).length;
    console.log(
      `[${chain}] wrote ${chain}-current-state.json and ${chain}-current-state.csv (still delegated: ${stillDelegated})`,
    );
  }

  const combinedOut = join(dir, "current-state-all-chains.json");
  writeFileSync(combinedOut, JSON.stringify(combined, null, 2));
  console.log(`\nWrote combined output: ${combinedOut}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

