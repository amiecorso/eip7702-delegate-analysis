import {
  HypersyncClient,
  type Query,
  type BlockField,
  type TransactionField,
} from "@envio-dev/hypersync-client";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  recoverAuthorityFromAuthorization,
  type HypersyncAuthorization,
} from "./eip7702";

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

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore
  }
}

function getHypersyncUrl() {
  if (process.env.HYPERSYNC_URL) return process.env.HYPERSYNC_URL;
  if (process.env.CHAIN) {
    return `https://${process.env.CHAIN}.hypersync.xyz`;
  }
  return "https://base.hypersync.xyz";
}

const DEFAULT_FROM_BLOCK = 13514406;
const TXN_TYPE = process.env.TXN_TYPE ? Number(process.env.TXN_TYPE) : 4;

const rawOutputPrefix =
  process.env.OUTPUT_PREFIX ?? process.env.CHAIN ?? "base";
const outputPrefix =
  rawOutputPrefix === "base" &&
  process.env.OUTPUT_PREFIX === undefined &&
  process.env.CHAIN === undefined
    ? ""
    : rawOutputPrefix;

function withPrefix(prefix: string, name: string) {
  return prefix ? `${prefix}-${name}` : name;
}

const OUTPUT_FILE = withPrefix(outputPrefix, "type4-authority-addresses.txt");
const SHARD_DIR = withPrefix(outputPrefix, "type4-authority-shards");
const STATE_FILE = withPrefix(outputPrefix, "type4-scan-state.json");
const LOG_RECOVERY_FAILURES = process.env.LOG_RECOVERY_FAILURES === "true";
const RECOVERY_FAILURES_FILE = withPrefix(outputPrefix, "recovery-failures.jsonl");

const DEBUG_SAMPLE = process.env.DEBUG_SAMPLE === "true";
const DEBUG_SAMPLE_LIMIT = process.env.DEBUG_SAMPLE_LIMIT
  ? Number(process.env.DEBUG_SAMPLE_LIMIT)
  : 3;

function isHexAddress(maybe: unknown): maybe is string {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{40}$/.test(maybe);
}

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

function shardForAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").slice(0, 2);
}

function extractAuthorityFromAuth(auth: any): string | undefined {
  const candidates = [
    auth?.authority,
    auth?.signer,
    auth?.from,
    auth?.account,
    auth?.authorizer,
    auth?.sender,
  ];
  for (const c of candidates) {
    if (isHexAddress(c)) return normalizeAddress(c);
  }
  return undefined;
}

function safeJsonPreview(obj: unknown, maxLen = 4000): string {
  const s =
    JSON.stringify(
      obj,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    ) ?? "";
  return s.length > maxLen ? s.slice(0, maxLen) + "\n...<truncated>..." : s;
}

function jsonLine(obj: unknown): string {
  return (
    (JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ??
      "") + "\n"
  );
}

type BufferedWrites = Map<string, string[]>;

function flushBuffers(dir: string, buffers: BufferedWrites) {
  for (const [shard, lines] of buffers) {
    if (lines.length === 0) continue;
    const outPath = join(dir, `${shard}.txt`);
    appendFileSync(outPath, lines.join(""));
    buffers.set(shard, []);
  }
}

function buildUniqueAddressFileFromShards(dir: string, outFile: string) {
  const entries = new Set(readdirSync(dir).filter((n) => n.endsWith(".txt")));

  const shardNames: string[] = [];
  for (let i = 0; i < 256; i++) {
    const s = i.toString(16).padStart(2, "0");
    if (entries.has(`${s}.txt`)) shardNames.push(s);
  }

  writeFileSync(outFile, "");

  let totalUnique = 0;
  for (const shard of shardNames) {
    const raw = readFileSync(join(dir, `${shard}.txt`), "utf8");
    const uniq = Array.from(
      new Set(
        raw
          .split("\n")
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean)
          .filter((a) => isHexAddress(a))
      )
    ).sort();

    if (uniq.length === 0) continue;
    appendFileSync(outFile, uniq.join("\n") + "\n");
    totalUnique += uniq.length;
  }

  return totalUnique;
}

async function main() {
  if (process.env.SKIP_DOTENV !== "true") {
    await loadDotEnvIfPresent();
  }

  if (!process.env.HYPERSYNC_API_KEY) {
    throw new Error(
      "Missing HYPERSYNC_API_KEY. Set it in your environment before running."
    );
  }

  mkdirSync(SHARD_DIR, { recursive: true });

  const fromBlockRaw = process.env.FROM_BLOCK?.trim();
  let fromBlock = fromBlockRaw ? Number(fromBlockRaw) : DEFAULT_FROM_BLOCK;

  const toBlockRaw = process.env.TO_BLOCK?.trim();
  const toBlock = toBlockRaw ? Number(toBlockRaw) : undefined;

  if (process.env.RESUME === "true") {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
        nextBlock?: number;
      };
      if (typeof state.nextBlock === "number" && state.nextBlock > 0) {
        fromBlock = state.nextBlock;
        console.log(
          `RESUME=true: using nextBlock=${state.nextBlock} from ${STATE_FILE}`
        );
      }
    } catch {
      // ignore missing/invalid state file
    }
  }

  const hypersyncClient = new HypersyncClient({
    url: getHypersyncUrl(),
    apiToken: process.env.HYPERSYNC_API_KEY,
  });

  // Preflight: clamp TO_BLOCK to what Hypersync has indexed. This avoids hard failures when TO_BLOCK is
  // beyond the Hypersync archive height (which can lag chain head / explorers).
  let hypersyncHeight: number | undefined;
  try {
    const maxAttempts = process.env.HYPERSYNC_HEIGHT_RETRIES
      ? Number(process.env.HYPERSYNC_HEIGHT_RETRIES)
      : 5;
    const baseDelayMs = process.env.HYPERSYNC_HEIGHT_RETRY_DELAY_MS
      ? Number(process.env.HYPERSYNC_HEIGHT_RETRY_DELAY_MS)
      : 250;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      try {
        hypersyncHeight = await hypersyncClient.getHeight();
        break;
      } catch {
        if (attempt === maxAttempts) break;
        const delay = Math.min(5000, baseDelayMs * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } catch {
    // ignore and proceed; stream responses will still include archiveHeight in many cases
  }

  let effectiveToBlock = toBlock;
  if (hypersyncHeight !== undefined) {
    // Hypersync query range is [fromBlock..toBlock), so use height+1 to include the current height.
    const maxToBlock = hypersyncHeight + 1;
    if (effectiveToBlock !== undefined && effectiveToBlock > maxToBlock) {
      console.log(
        `Clamping TO_BLOCK from ${effectiveToBlock} to ${maxToBlock} (Hypersync height=${hypersyncHeight})`
      );
      effectiveToBlock = maxToBlock;
    }

    if (effectiveToBlock === undefined) {
      console.log(
        `Hypersync height=${hypersyncHeight} (TIP). Consider setting TO_BLOCK=${maxToBlock} to pin the scan to a stable range.`
      );
    }
  } else if (effectiveToBlock !== undefined) {
    // If we couldn't fetch Hypersync height, it's safer to avoid sending a potentially-invalid TO_BLOCK,
    // since querying beyond Hypersync's indexed range can cause hard failures in the client.
    console.log(
      `Warning: unable to fetch Hypersync height; ignoring TO_BLOCK=${effectiveToBlock} (set TO_BLOCK empty to silence this).`
    );
    effectiveToBlock = undefined;
  }

  const streamConfig = {
    // Hypersync defaults to fairly high internal concurrency; dialing this down can help avoid transient
    // rate-limits / server timeouts on large scans.
    concurrency: process.env.HYPERSYNC_STREAM_CONCURRENCY
      ? Number(process.env.HYPERSYNC_STREAM_CONCURRENCY)
      : undefined,
    batchSize: process.env.HYPERSYNC_BATCH_SIZE
      ? Number(process.env.HYPERSYNC_BATCH_SIZE)
      : undefined,
    maxBatchSize: process.env.HYPERSYNC_MAX_BATCH_SIZE
      ? Number(process.env.HYPERSYNC_MAX_BATCH_SIZE)
      : undefined,
  };

  const query: Query = {
    fromBlock,
    toBlock: effectiveToBlock,
    transactions: [
      {
        type: [TXN_TYPE],
      },
    ],
    fieldSelection: {
      block: ["Number", "Timestamp", "Hash"] satisfies BlockField[],
      transaction: [
        "BlockNumber",
        "TransactionIndex",
        "Hash",
        "From",
        "Type",
        "AuthorizationList",
      ] satisfies TransactionField[],
    },
  };

  const buffers: BufferedWrites = new Map();
  let bufferedLines = 0;
  const FLUSH_THRESHOLD = 20_000;

  let totalTxns = 0;
  let totalAuths = 0;
  let recoveredAuthority = 0;
  let fallbackToTxFrom = 0;
  let debugPrinted = 0;
  const start = Date.now();
  let lastProgressLog = 0;

  console.log(
    `Scanning type-${TXN_TYPE} transactions from block ${fromBlock}${
      effectiveToBlock ? ` to ${effectiveToBlock}` : ""
    }...`
  );

  const USE_PAGINATED_GET = process.env.USE_PAGINATED_GET === "true";

  async function processOneResponse(res: any) {
    // Helpful for debugging hypersync indexing lag vs explorer head.
    if (
      totalAuths === 0 &&
      totalTxns === 0 &&
      typeof res.archiveHeight === "number"
    ) {
      if (toBlock && toBlock > res.archiveHeight) {
        console.log(
          `Note: TO_BLOCK=${toBlock} is above Hypersync archiveHeight=${res.archiveHeight}. Consider setting TO_BLOCK to ${res.archiveHeight} or leaving it empty.`
        );
      }
    }

    for (const txn of res.data.transactions) {
      totalTxns++;
      const from = txn.from ? normalizeAddress(txn.from) : undefined;

      const authList = (txn as any).authorizationList as any[] | undefined;
      if (!authList || authList.length === 0) continue;

      totalAuths += authList.length;

      if (DEBUG_SAMPLE && debugPrinted < DEBUG_SAMPLE_LIMIT) {
        const first = authList[0];
        const keys =
          first && typeof first === "object" ? Object.keys(first) : [];
        console.log("\n--- DEBUG_SAMPLE authorizationList[0] ---");
        console.log("tx.hash:", txn.hash);
        console.log("tx.from:", txn.from);
        console.log("tx.type:", (txn as any).type);
        console.log("auth[0] keys:", keys);
        console.log(safeJsonPreview(first));
        debugPrinted++;
      }

      for (const auth of authList) {
        let authority: string | undefined;
        let recovered = false;
        try {
          authority = recoverAuthorityFromAuthorization(
            auth as HypersyncAuthorization
          );
          recovered = true;
        } catch (e) {
          if (LOG_RECOVERY_FAILURES) {
            try {
              appendFileSync(
                RECOVERY_FAILURES_FILE,
                jsonLine({
                  txHash: txn.hash ?? null,
                  txFrom: txn.from ?? null,
                  chainId: (auth as any)?.chainId ?? null,
                  nonce: (auth as any)?.nonce ?? null,
                  yParity: (auth as any)?.yParity ?? null,
                  r: (auth as any)?.r ?? null,
                  s: (auth as any)?.s ?? null,
                  address: (auth as any)?.address ?? null,
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
            } catch {
              // ignore logging failures
            }
          }
          authority = extractAuthorityFromAuth(auth) ?? from;
        }
        if (!authority) continue;

        if (recovered) recoveredAuthority++;
        else if (authority === from) fallbackToTxFrom++;

        const shard = shardForAddress(authority);
        const arr = buffers.get(shard) ?? [];
        arr.push(authority + "\n");
        buffers.set(shard, arr);
        bufferedLines++;

        if (bufferedLines >= FLUSH_THRESHOLD) {
          flushBuffers(SHARD_DIR, buffers);
          bufferedLines = 0;
        }
      }

      if (DEBUG_SAMPLE && debugPrinted >= DEBUG_SAMPLE_LIMIT) {
        break;
      }
    }

    if (res.nextBlock) query.fromBlock = res.nextBlock;

    if (res.nextBlock) {
      try {
        writeFileSync(
          STATE_FILE,
          JSON.stringify({ nextBlock: res.nextBlock }, null, 2)
        );
      } catch {
        // ignore state write failures
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastProgressLog >= 5) {
      console.log(
        `Progress: nextBlock=${
          res.nextBlock
        } txns=${totalTxns} auths=${totalAuths} elapsed=${elapsed.toFixed(1)}s`
      );
      lastProgressLog = elapsed;
    }

    return res;
  }

  if (USE_PAGINATED_GET) {
    const delayMs = process.env.HYPERSYNC_REQUEST_DELAY_MS
      ? Number(process.env.HYPERSYNC_REQUEST_DELAY_MS)
      : 0;
    let attempts = 0;

    while (true) {
      try {
        const res = await hypersyncClient.get(query);
        attempts = 0;
        await processOneResponse(res);

        if (DEBUG_SAMPLE && debugPrinted >= DEBUG_SAMPLE_LIMIT) break;

        const nextBlock = (res as any).nextBlock as number | undefined;
        if (!nextBlock) break;

        if (
          ((res as any).archiveHeight &&
            nextBlock >= (res as any).archiveHeight) ||
          ((query as any).toBlock && nextBlock >= (query as any).toBlock)
        ) {
          break;
        }

        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      } catch (e) {
        attempts++;
        const backoffMs = Math.min(30_000, 250 * 2 ** Math.min(10, attempts));
        console.warn(
          `Hypersync get() failed (attempt=${attempts}); backing off ${backoffMs}ms`
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  } else {
    const stream = await hypersyncClient.stream(query, streamConfig as any);
    while (true) {
      const res = await stream.recv();
      if (!res) break;

      await processOneResponse(res);

      if (DEBUG_SAMPLE && debugPrinted >= DEBUG_SAMPLE_LIMIT) {
        await stream.close();
        break;
      }

      if (
        (res.archiveHeight && res.nextBlock >= res.archiveHeight) ||
        ((query as any).toBlock && res.nextBlock >= (query as any).toBlock)
      ) {
        break;
      }
    }
  }

  flushBuffers(SHARD_DIR, buffers);

  console.log("Building deduped authority address list from shards...");
  const totalUnique = buildUniqueAddressFileFromShards(SHARD_DIR, OUTPUT_FILE);

  const elapsed = (Date.now() - start) / 1000;
  console.log(
    `Done. txns=${totalTxns} auths=${totalAuths} uniqueAuthorities=${totalUnique} elapsed=${elapsed.toFixed(
      1
    )}s`
  );
  if (DEBUG_SAMPLE && totalAuths === 0) {
    console.log(
      "DEBUG_SAMPLE note: saw 0 authorizationList entries in this block range. Try expanding TO_BLOCK, moving FROM_BLOCK, or removing TO_BLOCK."
    );
  }
  console.log(
    `Authority recovery: recovered=${recoveredAuthority} fallback_to_tx_from=${fallbackToTxFrom} total_auths=${totalAuths}`
  );
  console.log(`Wrote: ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
