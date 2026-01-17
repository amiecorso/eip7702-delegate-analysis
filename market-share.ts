import { readFileSync, writeFileSync } from "node:fs";
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

const EIP7702_PREFIX = "0xef0100";

function envKeyForChain(prefix: string, chain: string) {
  return `${prefix}_${chain.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function isHexAddress(maybe: unknown): maybe is string {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{40}$/.test(maybe);
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function parseAddressesFile(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .filter((a) => isHexAddress(a));
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  id: number,
): Promise<T> {
  const maxRetries = process.env.RPC_MAX_RETRIES ? Number(process.env.RPC_MAX_RETRIES) : 8;
  const baseDelayMs = process.env.RPC_RETRY_BASE_DELAY_MS
    ? Number(process.env.RPC_RETRY_BASE_DELAY_MS)
    : 250;
  const maxDelayMs = process.env.RPC_RETRY_MAX_DELAY_MS
    ? Number(process.env.RPC_RETRY_MAX_DELAY_MS)
    : 10_000;
  const requestDelayMs = process.env.RPC_REQUEST_DELAY_MS
    ? Number(process.env.RPC_REQUEST_DELAY_MS)
    : 0;
  const stats: {
    totalCalls: number;
    totalRetries: number;
    http429: number;
    http5xx: number;
    otherHttp: number;
    jsonRpcRetryable: number;
  } | undefined = (globalThis as any).__rpcStats;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats && (stats.totalCalls += attempt === 0 ? 1 : 0);
    if (requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, requestDelayMs));
    }

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    if (!res.ok) {
      const status = res.status;
      const retryable = status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504;

      if (!retryable || attempt === maxRetries) {
        stats && (stats.otherHttp += status !== 429 && status < 500 ? 1 : 0);
        throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
      }

      stats && (stats.totalRetries += 1);
      if (status === 429) stats && (stats.http429 += 1);
      if (status >= 500) stats && (stats.http5xx += 1);

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.min(250, backoff));
      await new Promise((r) => setTimeout(r, backoff + jitter));
      continue;
    }

    const json = (await res.json()) as any;
    if (json.error) {
      // Some providers return JSON-RPC errors for rate limits; treat these as retryable when possible.
      const msg = typeof json.error?.message === "string" ? json.error.message : "";
      const retryable =
        msg.toLowerCase().includes("rate") ||
        msg.toLowerCase().includes("limit") ||
        msg.toLowerCase().includes("timeout");
      if (retryable && attempt < maxRetries) {
        stats && (stats.totalRetries += 1);
        stats && (stats.jsonRpcRetryable += 1);
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const jitter = Math.floor(Math.random() * Math.min(250, backoff));
        await new Promise((r) => setTimeout(r, backoff + jitter));
        continue;
      }
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result as T;
  }

  throw new Error("RPC call failed after retries");
}

function parseDelegationTargetFromCode(code: string): { delegate?: string; hasExtraBytes: boolean } {
  const c = code.toLowerCase();
  if (!c.startsWith(EIP7702_PREFIX)) return { delegate: undefined, hasExtraBytes: false };

  const rest = c.slice(EIP7702_PREFIX.length);
  if (rest.length < 40) return { delegate: undefined, hasExtraBytes: false };

  const delegate = `0x${rest.slice(0, 40)}`;
  const hasExtraBytes = rest.length !== 40;
  return { delegate, hasExtraBytes };
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

function resolveAuthoritiesFile(chain: string, outputDir: string): string {
  const override = process.env.AUTHORITIES_FILE;
  if (override) return override;

  const candidates =
    chain === "base"
      ? ["type4-authority-addresses.txt", "base-type4-authority-addresses.txt"]
      : [`${chain}-type4-authority-addresses.txt`];

  for (const name of candidates) {
    const p = join(outputDir, name);
    try {
      readFileSync(p, "utf8");
      return p;
    } catch {
      // keep trying
    }
  }

  throw new Error(
    `No authorities file found for chain=${chain}. Tried: ${candidates.join(
      ", ",
    )}. Set AUTHORITIES_FILE to override.`,
  );
}

async function main() {
  loadDotEnvIfPresent();

  const chain = (process.env.CHAIN ?? "base").trim();
  const rpcUrl =
    process.env[envKeyForChain("RPC_URL", chain)] ??
    (process.env.CHAIN === chain ? process.env.RPC_URL : undefined);

  if (!rpcUrl) {
    throw new Error(
      `Missing RPC URL env for chain=${chain}. Set ${envKeyForChain("RPC_URL", chain)} (e.g. RPC_URL_BASE).`,
    );
  }

  const outputDir = process.env.OUTPUT_DIR ?? ".";
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  const dir = outputDir || scriptDir;

  const authoritiesFile = resolveAuthoritiesFile(chain, dir);
  const addresses = parseAddressesFile(authoritiesFile);
  const uniqueAddresses = Array.from(new Set(addresses)).sort();

  const concurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 16;
  const chunkSize = process.env.CHUNK_SIZE ? Number(process.env.CHUNK_SIZE) : 25_000;
  const resume = process.env.RESUME === "true";
  const progressEveryMs = process.env.PROGRESS_EVERY_MS
    ? Number(process.env.PROGRESS_EVERY_MS)
    : 10_000;

  const checkpointFile =
    process.env.CHECKPOINT_FILE ??
    join(dir, `${chain}-delegate-market-share.checkpoint.json`);

  const coinbaseDelegateRaw = process.env.COINBASE_DELEGATE_ADDRESS;
  const coinbaseDelegate = coinbaseDelegateRaw ? normalizeAddress(coinbaseDelegateRaw) : undefined;
  if (coinbaseDelegateRaw && !isHexAddress(coinbaseDelegateRaw)) {
    throw new Error("COINBASE_DELEGATE_ADDRESS must be a 0x-prefixed 20-byte hex address.");
  }

  console.log(
    `[${chain}] computing current delegate market share for ${uniqueAddresses.length} candidate EOAs (concurrency=${concurrency})`,
  );

  const rpcStats = {
    totalCalls: 0,
    totalRetries: 0,
    http429: 0,
    http5xx: 0,
    otherHttp: 0,
    jsonRpcRetryable: 0,
  };
  (globalThis as any).__rpcStats = rpcStats;

  const counts = new Map<string, number>();
  let currentlyDelegated = 0;
  let extraBytesCount = 0;
  let rpcFailures = 0;

  let nextIndex = 0;

  if (resume) {
    try {
      const raw = readFileSync(checkpointFile, "utf8");
      const parsed = JSON.parse(raw) as {
        nextIndex?: number;
        counts?: Record<string, number>;
        currentlyDelegated?: number;
        extraBytesCount?: number;
        rpcFailures?: number;
      };
      if (typeof parsed.nextIndex === "number" && parsed.nextIndex >= 0) {
        nextIndex = parsed.nextIndex;
      }
      if (parsed.counts && typeof parsed.counts === "object") {
        for (const [k, v] of Object.entries(parsed.counts)) {
          if (typeof v === "number" && v > 0) counts.set(k, v);
        }
      }
      if (typeof parsed.currentlyDelegated === "number") {
        currentlyDelegated = parsed.currentlyDelegated;
      }
      if (typeof parsed.extraBytesCount === "number") {
        extraBytesCount = parsed.extraBytesCount;
      }
      if (typeof parsed.rpcFailures === "number") {
        rpcFailures = parsed.rpcFailures;
      }

      console.log(
        `[${chain}] RESUME=true: loaded checkpoint ${checkpointFile} nextIndex=${nextIndex} currentlyDelegated=${currentlyDelegated}`,
      );
    } catch {
      // ignore missing checkpoint
    }
  }

  const startedAt = Date.now();
  let lastProgressAt = 0;

  for (let start = nextIndex; start < uniqueAddresses.length; start += chunkSize) {
    const end = Math.min(uniqueAddresses.length, start + chunkSize);
    const chunk = uniqueAddresses.slice(start, end);

    const delegates = await mapWithConcurrency(chunk, concurrency, async (addr, i) => {
      try {
        const code = await rpcCall<string>(
          rpcUrl,
          "eth_getCode",
          [addr, "latest"],
          // IDs only need to be unique-ish; include offsets to reduce collision in logs/traces.
          start * 1000 + i + 1,
        );
        const parsed = parseDelegationTargetFromCode(code);
        if (parsed.hasExtraBytes) extraBytesCount++;
        return parsed.delegate ? normalizeAddress(parsed.delegate) : undefined;
      } catch {
        rpcFailures++;
        return undefined;
      }
    });

    for (const d of delegates) {
      if (!d) continue;
      currentlyDelegated++;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }

    nextIndex = end;
    try {
      writeFileSync(
        checkpointFile,
        JSON.stringify(
          {
            chain,
            authoritiesFile,
            nextIndex,
            candidates: uniqueAddresses.length,
            currentlyDelegated,
            extraBytesCount,
            rpcFailures,
            counts: Object.fromEntries(counts.entries()),
            rpcStats,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // ignore checkpoint write failures
    }

    const now = Date.now();
    if (now - lastProgressAt >= progressEveryMs) {
      const elapsedSec = (now - startedAt) / 1000;
      const done = nextIndex;
      const rate = done / Math.max(1, elapsedSec);
      const remaining = uniqueAddresses.length - done;
      const etaSec = remaining / Math.max(0.0001, rate);
      console.log(
        `[${chain}] progress ${done}/${uniqueAddresses.length} (${(
          (done / uniqueAddresses.length) *
          100
        ).toFixed(2)}%) rate=${rate.toFixed(1)} addr/s eta=${Math.round(
          etaSec / 60,
        )}m retries=${rpcStats.totalRetries} http429=${rpcStats.http429} failures=${rpcFailures}`,
      );
      lastProgressAt = now;
    }
  }

  delete (globalThis as any).__rpcStats;

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.map(([delegate, count], idx) => ({
    rank: idx + 1,
    delegate,
    count,
    share: currentlyDelegated ? count / currentlyDelegated : 0,
    isCoinbase: coinbaseDelegate ? delegate === coinbaseDelegate : false,
  }));

  const coinbaseEntry = coinbaseDelegate
    ? top.find((t) => t.delegate === coinbaseDelegate)
    : undefined;

  const outJson = join(dir, `${chain}-delegate-market-share.json`);
  writeFileSync(
    outJson,
    JSON.stringify(
      {
        chain,
        candidates: uniqueAddresses.length,
        currentlyDelegated,
        uniqueDelegates: counts.size,
        hasExtraBytesCount: extraBytesCount,
        rpcFailures,
        checkpointFile,
        rpcStats,
        coinbaseDelegate,
        coinbase: coinbaseEntry
          ? {
              rank: coinbaseEntry.rank,
              count: coinbaseEntry.count,
              share: coinbaseEntry.share,
            }
          : coinbaseDelegate
            ? { rank: null, count: 0, share: 0 }
            : null,
        delegates: top,
      },
      null,
      2,
    ),
  );

  const outCsv = join(dir, `${chain}-delegate-market-share.csv`);
  const header = "rank,delegate,count,share,is_coinbase\n";
  const lines = top.map((t) =>
    [
      t.rank,
      t.delegate,
      t.count,
      t.share.toFixed(10),
      t.isCoinbase ? "true" : "false",
    ].join(","),
  );
  writeFileSync(outCsv, header + lines.join("\n") + "\n");

  console.log(`[${chain}] wrote ${outJson} and ${outCsv}`);
  if (coinbaseDelegate) {
    console.log(
      `[${chain}] coinbase delegate ${coinbaseDelegate}: ${
        coinbaseEntry
          ? `rank=${coinbaseEntry.rank} count=${coinbaseEntry.count} share=${(
              coinbaseEntry.share * 100
            ).toFixed(4)}%`
          : "not present (0 currently-delegated EOAs)"
      }`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

