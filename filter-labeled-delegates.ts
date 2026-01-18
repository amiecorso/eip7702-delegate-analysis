import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

type CliOpts = {
  inputJson?: string;
  labelsJson?: string;
  outDir?: string;
  outBaseName?: string;
  labelRequireName?: string;
};

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }

    const eq = a.indexOf("=");
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
    const value = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
    if (eq === -1) i++;

    if (!key) continue;
    (opts as any)[key.replaceAll("-", "_")] = value;
  }

  // positional 0 = input json
  if (!opts.inputJson && positionals[0]) opts.inputJson = positionals[0];
  return opts;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

type Candidate = { path: string; mtimeMs: number };

function findMarketShareJsonCandidates(root: string): Candidate[] {
  const out: Candidate[] = [];
  if (!root || !isDirectory(root)) return out;

  const stack: string[] = [root];
  let visited = 0;
  const VISIT_LIMIT = 50_000;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (visited++ > VISIT_LIMIT) break;

    for (const name of safeListDir(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(dir, name);

      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(p);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }

      // Prefer the raw market share JSON output from market-share.ts.
      if (!name.endsWith("-delegate-market-share.json")) continue;

      // Avoid picking derived outputs by default; those can still be selected manually via INPUT_JSON.
      if (
        name.endsWith("-delegate-market-share-by-wallet.json") ||
        name.endsWith("-delegate-market-share-labeled-only.json")
      ) {
        continue;
      }

      out.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function resolveInputJsonOrThrow(explicit: string | undefined, outDir: string): string {
  const placeholderHint =
    "It looks like INPUT_JSON still contains the README placeholder `<timestamp>`. Replace it with a real path.";

  if (explicit && explicit.includes("<timestamp>")) {
    const candidates = [
      ...findMarketShareJsonCandidates(outDir),
      ...findMarketShareJsonCandidates("results"),
      ...findMarketShareJsonCandidates("."),
    ];
    const examples = candidates.slice(0, 10).map((c) => `- ${c.path}`).join("\n");
    throw new Error(
      `${placeholderHint}\n\nFound these candidate files:\n${
        examples || "(none found)"
      }\n\nSet INPUT_JSON to one of the above and re-run.`,
    );
  }

  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [
    ...findMarketShareJsonCandidates(outDir),
    ...findMarketShareJsonCandidates("results"),
    ...findMarketShareJsonCandidates("."),
  ];

  if (explicit && !existsSync(explicit)) {
    const examples = candidates.slice(0, 10).map((c) => `- ${c.path}`).join("\n");
    throw new Error(
      `INPUT_JSON does not exist: ${explicit}\n\nFound these candidate files:\n${
        examples || "(none found)"
      }\n\nSet INPUT_JSON to one of the above and re-run.`,
    );
  }

  if (candidates.length > 0) {
    const picked = candidates[0].path;
    console.log(`INPUT_JSON not set; using newest candidate: ${picked}`);
    return picked;
  }

  throw new Error(
    "Missing INPUT_JSON (path to <chain>-delegate-market-share.json), and could not auto-discover one. Set INPUT_JSON and re-run.",
  );
}

function main() {
  const cli = parseCli(process.argv.slice(2));

  const labelsJson =
    cli.labelsJson ?? process.env.LABELS_JSON ?? "labels/wintermute-custom-labels.json";

  const inputJson = resolveInputJsonOrThrow(
    cli.inputJson ?? process.env.INPUT_JSON,
    cli.outDir ?? process.env.OUTPUT_DIR ?? ".",
  );

  const outDir =
    cli.outDir ?? process.env.OUTPUT_DIR ?? (inputJson ? dirname(inputJson) : ".");

  // Default is strict: only keep entries where the labels file has a non-empty `name`.
  // This treats "present but name=null" as unlabeled/unknown.
  const requireName = (
    cli.labelRequireName ??
    process.env.LABEL_REQUIRE_NAME ??
    "true"
  ).toLowerCase() !== "false";

  const ms = loadJson<MarketShareJson>(inputJson);
  const labelsFile = loadJson<LabelsFile>(labelsJson);

  const byAddr = new Map<string, { name: string | null; category: string | null }>();
  for (const l of labelsFile.labels) {
    byAddr.set(normalizeAddress(l.address), { name: l.name, category: l.category });
  }

  const coinbaseDelegate = ms.coinbaseDelegate ? normalizeAddress(ms.coinbaseDelegate) : null;

  const kept: Array<
    DelegateRow & { labelName?: string | null; labelCategory?: string | null }
  > = [];
  let droppedCount = 0;
  let droppedDelegated = 0;

  for (const row of ms.delegates) {
    const addr = normalizeAddress(row.delegate);
    const label = byAddr.get(addr);

    const hasName = !!(label?.name && label.name.trim().length > 0);
    const isLabeled = requireName ? hasName : label !== undefined;

    if (!isLabeled) {
      droppedCount += 1;
      droppedDelegated += row.count;
      continue;
    }

    kept.push({
      ...row,
      labelName: label?.name ?? null,
      labelCategory: label?.category ?? null,
      isCoinbase: coinbaseDelegate ? addr === coinbaseDelegate : row.isCoinbase,
    });
  }

  const keptCurrentlyDelegated = kept.reduce((acc, r) => acc + r.count, 0);
  const sorted = kept.sort((a, b) => b.count - a.count);

  const delegates = sorted.map((r, idx) => ({
    rank: idx + 1,
    delegate: r.delegate,
    count: r.count,
    share: keptCurrentlyDelegated ? r.count / keptCurrentlyDelegated : 0,
    isCoinbase: r.isCoinbase,
    labelName: r.labelName ?? null,
    labelCategory: r.labelCategory ?? null,
  }));

  const coinbaseEntry = coinbaseDelegate
    ? delegates.find((d) => normalizeAddress(d.delegate) === coinbaseDelegate)
    : delegates.find((d) => d.isCoinbase);

  const outBaseName =
    cli.outBaseName ??
    process.env.OUTPUT_BASENAME ??
    `${ms.chain}-delegate-market-share-labeled-only`;

  const outJson = join(outDir, `${outBaseName}.json`);
  const outCsv = join(outDir, `${outBaseName}.csv`);

  writeFileSync(
    outJson,
    JSON.stringify(
      {
        chain: ms.chain,
        mode: "labeled_only",
        inputJson,
        labelsJson,
        labelRequireName: requireName,

        // Keep the original candidates count (this is the authority EOA universe scanned by market-share).
        candidates: ms.candidates,

        // Rebased totals: this is the denominator for shares in this output.
        currentlyDelegated: keptCurrentlyDelegated,
        uniqueDelegates: delegates.length,

        // Helpful context about what was removed.
        dropped: {
          uniqueDelegates: droppedCount,
          currentlyDelegated: droppedDelegated,
          shareOfOriginalCurrentlyDelegated: ms.currentlyDelegated
            ? droppedDelegated / ms.currentlyDelegated
            : 0,
        },

        // Pass through (if present) for convenience/debugging.
        original: {
          currentlyDelegated: ms.currentlyDelegated,
          uniqueDelegates: ms.uniqueDelegates,
          hasExtraBytesCount: ms.hasExtraBytesCount,
          rpcFailures: ms.rpcFailures,
          checkpointFile: ms.checkpointFile,
        },

        coinbaseDelegate: ms.coinbaseDelegate ?? null,
        coinbase: ms.coinbaseDelegate
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

  const header = "rank,delegate,label,category,count,share,is_coinbase\n";
  const lines = delegates.map((d) =>
    [
      d.rank,
      d.delegate,
      JSON.stringify(d.labelName ?? ""),
      JSON.stringify(d.labelCategory ?? ""),
      d.count,
      d.share.toFixed(10),
      d.isCoinbase ? "true" : "false",
    ].join(","),
  );
  writeFileSync(outCsv, header + lines.join("\n") + "\n");

  console.log(`Wrote: ${outJson}`);
  console.log(`Wrote: ${outCsv}`);
  console.log(
    `Dropped unlabeled delegates: unique=${droppedCount} delegated=${droppedDelegated} (${(
      (ms.currentlyDelegated ? droppedDelegated / ms.currentlyDelegated : 0) * 100
    ).toFixed(2)}% of original currentlyDelegated)`,
  );
  if (coinbaseEntry) {
    console.log(
      `Coinbase share (labeled-only): ${(coinbaseEntry.share * 100).toFixed(4)}% (${coinbaseEntry.count.toLocaleString()} / ${keptCurrentlyDelegated.toLocaleString()})`,
    );
  }
}

main();

