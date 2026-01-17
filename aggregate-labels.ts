import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  coinbaseDelegate?: string | null;
  delegates: DelegateRow[];
};

type LabelEntry = {
  address: string;
  name: string | null;
  category: string | null;
};
type LabelsFile = { labels: LabelEntry[] };

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const inputJson = process.env.INPUT_JSON;
  if (!inputJson) {
    throw new Error(
      "Missing INPUT_JSON (path to <chain>-delegate-market-share.json)."
    );
  }

  const labelsJson =
    process.env.LABELS_JSON ?? "labels/wintermute-custom-labels.json";
  const outDir = process.env.OUTPUT_DIR ?? ".";

  const unlabeledMode = (process.env.UNLABELED_MODE ?? "group").toLowerCase(); // group | keep
  if (unlabeledMode !== "group" && unlabeledMode !== "keep") {
    throw new Error("UNLABELED_MODE must be 'group' or 'keep'.");
  }

  const ms = loadJson<MarketShareJson>(inputJson);
  const labelsFile = loadJson<LabelsFile>(labelsJson);

  const byAddr = new Map<
    string,
    { name: string | null; category: string | null }
  >();
  for (const l of labelsFile.labels) {
    byAddr.set(normalizeAddress(l.address), {
      name: l.name,
      category: l.category,
    });
  }

  type Agg = {
    key: string; // wallet name, delegate address, or "Unlabeled"
    category: string | null;
    count: number;
    members: number;
    isCoinbase: boolean;
  };

  const coinbaseDelegate = ms.coinbaseDelegate
    ? normalizeAddress(ms.coinbaseDelegate)
    : null;

  const groups = new Map<string, Agg>();

  function ensure(key: string): Agg {
    const existing = groups.get(key);
    if (existing) return existing;
    const a: Agg = {
      key,
      category: null,
      count: 0,
      members: 0,
      isCoinbase: false,
    };
    groups.set(key, a);
    return a;
  }

  for (const row of ms.delegates) {
    const delegateAddr = normalizeAddress(row.delegate);
    const label = byAddr.get(delegateAddr);

    let key: string;
    if (label?.name) key = label.name;
    else key = unlabeledMode === "group" ? "Unlabeled" : delegateAddr;

    const g = ensure(key);
    g.count += row.count;
    g.members += 1;

    const cat = label?.category ?? null;
    if (cat) {
      if (g.category === null) g.category = cat;
      else if (g.category !== cat) g.category = "Mixed";
    }

    if (coinbaseDelegate && delegateAddr === coinbaseDelegate) {
      g.isCoinbase = true;
    }
  }

  const sorted = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const delegates: Array<
    DelegateRow & { category?: string | null; members?: number }
  > = sorted.map((g, idx) => ({
    rank: idx + 1,
    delegate: g.key,
    count: g.count,
    share: ms.currentlyDelegated ? g.count / ms.currentlyDelegated : 0,
    isCoinbase: g.isCoinbase,
    category: g.category,
    members: g.members,
  }));

  const coinbase = delegates.find((d) => d.isCoinbase);

  const outBaseName =
    process.env.OUTPUT_BASENAME ??
    `${ms.chain}-delegate-market-share-by-wallet`;
  const outJson = join(outDir, `${outBaseName}.json`);
  const outCsv = join(outDir, `${outBaseName}.csv`);

  writeFileSync(
    outJson,
    JSON.stringify(
      {
        chain: ms.chain,
        mode: "by_wallet",
        inputJson,
        labelsJson,
        unlabeledMode,
        candidates: ms.candidates,
        currentlyDelegated: ms.currentlyDelegated,
        uniqueDelegates: delegates.length,
        coinbaseDelegate: ms.coinbaseDelegate ?? null,
        coinbase: coinbase
          ? {
              rank: coinbase.rank,
              count: coinbase.count,
              share: coinbase.share,
            }
          : ms.coinbaseDelegate
          ? { rank: null, count: 0, share: 0 }
          : null,
        delegates,
      },
      null,
      2
    )
  );

  const header = "rank,label,category,count,share,is_coinbase,members\n";
  const lines = delegates.map((d) =>
    [
      d.rank,
      JSON.stringify(d.delegate),
      JSON.stringify(d.category ?? ""),
      d.count,
      d.share.toFixed(10),
      d.isCoinbase ? "true" : "false",
      d.members ?? "",
    ].join(",")
  );
  writeFileSync(outCsv, header + lines.join("\n") + "\n");

  console.log(`Wrote: ${outJson}`);
  console.log(`Wrote: ${outCsv}`);
}

main();
