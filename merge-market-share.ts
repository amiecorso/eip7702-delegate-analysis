import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type DelegateRow = {
  rank: number;
  delegate: string;
  count: number;
  share: number;
  isCoinbase: boolean;
};

type MarketShareJson = {
  chain: string;
  candidates: number;
  currentlyDelegated: number;
  uniqueDelegates: number;
  hasExtraBytesCount?: number;
  rpcFailures?: number;
  checkpointFile?: string;
  rpcStats?: unknown;
  coinbaseDelegate?: string | null;
  coinbase?: { rank: number | null; count: number; share: number } | null;
  delegates: DelegateRow[];
};

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function main() {
  const aPath = process.env.INPUT_A;
  const bPath = process.env.INPUT_B;
  if (!aPath || !bPath) {
    throw new Error("Missing INPUT_A and/or INPUT_B (paths to *-delegate-market-share.json).");
  }

  const outDir = process.env.OUTPUT_DIR ?? dirname(aPath);
  const outBase = process.env.OUTPUT_BASENAME ?? "base-delegate-market-share-merged";

  const a = loadJson<MarketShareJson>(aPath);
  const b = loadJson<MarketShareJson>(bPath);

  if (a.chain !== b.chain) {
    throw new Error(`Chain mismatch: INPUT_A=${a.chain} INPUT_B=${b.chain}`);
  }

  const coinbaseDelegate =
    a.coinbaseDelegate ?? b.coinbaseDelegate ?? null;
  if (
    a.coinbaseDelegate &&
    b.coinbaseDelegate &&
    normalizeAddress(a.coinbaseDelegate) !== normalizeAddress(b.coinbaseDelegate)
  ) {
    throw new Error(
      `coinbaseDelegate mismatch: INPUT_A=${a.coinbaseDelegate} INPUT_B=${b.coinbaseDelegate}`,
    );
  }

  // Merge counts by delegate address (assumes INPUT_A and INPUT_B are market-share runs over disjoint EOA
  // sets; if they overlap, the merge will double-count those EOAs).
  const counts = new Map<string, number>();
  for (const row of a.delegates) {
    counts.set(normalizeAddress(row.delegate), (counts.get(normalizeAddress(row.delegate)) ?? 0) + row.count);
  }
  for (const row of b.delegates) {
    counts.set(normalizeAddress(row.delegate), (counts.get(normalizeAddress(row.delegate)) ?? 0) + row.count);
  }

  const currentlyDelegated = a.currentlyDelegated + b.currentlyDelegated;
  const candidates = a.candidates + b.candidates;
  const rpcFailures = (a.rpcFailures ?? 0) + (b.rpcFailures ?? 0);
  const hasExtraBytesCount = (a.hasExtraBytesCount ?? 0) + (b.hasExtraBytesCount ?? 0);

  const sorted = Array.from(counts.entries()).sort((x, y) => y[1] - x[1]);
  const delegates = sorted.map(([delegate, count], idx) => ({
    rank: idx + 1,
    delegate,
    count,
    share: currentlyDelegated ? count / currentlyDelegated : 0,
    isCoinbase: coinbaseDelegate ? delegate === normalizeAddress(coinbaseDelegate) : false,
  }));

  const coinbaseEntry = coinbaseDelegate
    ? delegates.find((d) => d.delegate === normalizeAddress(coinbaseDelegate))
    : undefined;

  const outJson = join(outDir, `${outBase}.json`);
  const outCsv = join(outDir, `${outBase}.csv`);

  writeFileSync(
    outJson,
    JSON.stringify(
      {
        chain: a.chain,
        mode: "merged_market_share",
        inputs: { a: aPath, b: bPath },
        candidates,
        currentlyDelegated,
        uniqueDelegates: counts.size,
        hasExtraBytesCount,
        rpcFailures,
        coinbaseDelegate,
        coinbase: coinbaseDelegate
          ? coinbaseEntry
            ? { rank: coinbaseEntry.rank, count: coinbaseEntry.count, share: coinbaseEntry.share }
            : { rank: null, count: 0, share: 0 }
          : null,
        delegates,
      },
      null,
      2,
    ),
  );

  const header = "rank,delegate,count,share,is_coinbase\n";
  const lines = delegates.map((t) =>
    [t.rank, t.delegate, t.count, t.share.toFixed(10), t.isCoinbase ? "true" : "false"].join(","),
  );
  writeFileSync(outCsv, header + lines.join("\n") + "\n");

  console.log(`Wrote: ${outJson}`);
  console.log(`Wrote: ${outCsv}`);
  if (coinbaseDelegate) {
    console.log(
      `[${a.chain}] coinbase delegate ${normalizeAddress(coinbaseDelegate)}: ${
        coinbaseEntry
          ? `rank=${coinbaseEntry.rank} count=${coinbaseEntry.count} share=${(coinbaseEntry.share * 100).toFixed(4)}%`
          : "not present (0 currently-delegated EOAs)"
      }`,
    );
  }
}

main();

