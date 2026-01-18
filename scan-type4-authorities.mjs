import { HypersyncClient } from "@envio-dev/hypersync-client";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { recoverAuthorityFromAuthorization } from "./eip7702.mjs";

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
  if (process.env.CHAIN) return `https://${process.env.CHAIN}.hypersync.xyz`;
  return "https://base.hypersync.xyz";
}

const DEFAULT_FROM_BLOCK = 13514406;
const TXN_TYPE = process.env.TXN_TYPE ? Number(process.env.TXN_TYPE) : 4;

const rawOutputPrefix = process.env.OUTPUT_PREFIX ?? process.env.CHAIN ?? "base";
const outputPrefix =
  rawOutputPrefix === "base" &&
  process.env.OUTPUT_PREFIX === undefined &&
  process.env.CHAIN === undefined
    ? ""
    : rawOutputPrefix;

function withPrefix(prefix, name) {
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

function isHexAddress(maybe) {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{40}$/.test(maybe);
}

function normalizeAddress(addr) {
  return addr.toLowerCase();
}

function shardForAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, "").slice(0, 2);
}

function safeJsonPreview(obj, maxLen = 4000) {
  const s =
    JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) ??
    "";
  return s.length > maxLen ? s.slice(0, maxLen) + "\n...<truncated>..." : s;
}

function jsonLine(obj) {
  return (
    (JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v)) ??
      "") + "\n"
  );
}

function flushBuffers(dir, buffers) {
  for (const [shard, lines] of buffers) {
    if (lines.length === 0) continue;
    appendFileSync(join(dir, `${shard}.txt`), lines.join(""));
    buffers.set(shard, []);
  }
}

function buildUniqueAddressFileFromShards(dir, outFile) {
  const entries = new Set(readdirSync(dir).filter((n) => n.endsWith(".txt")));
  const shardNames = [];
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
          .filter((a) => isHexAddress(a)),
      ),
    ).sort();

    if (uniq.length === 0) continue;
    appendFileSync(outFile, uniq.join("\n") + "\n");
    totalUnique += uniq.length;
  }

  return totalUnique;
}

async function main() {
  if (process.env.SKIP_DOTENV !== "true") loadDotEnvIfPresent();

  if (!process.env.HYPERSYNC_API_KEY) {
    throw new Error("Missing HYPERSYNC_API_KEY. Set it in your environment before running.");
  }

  mkdirSync(SHARD_DIR, { recursive: true });

  const fromBlockRaw = process.env.FROM_BLOCK?.trim();
  let fromBlock = fromBlockRaw ? Number(fromBlockRaw) : DEFAULT_FROM_BLOCK;

  const toBlockRaw = process.env.TO_BLOCK?.trim();
  const toBlock = toBlockRaw ? Number(toBlockRaw) : undefined;

  if (process.env.RESUME === "true") {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (typeof state.nextBlock === "number" && state.nextBlock > 0) {
        fromBlock = state.nextBlock;
        console.log(`RESUME=true: using nextBlock=${state.nextBlock} from ${STATE_FILE}`);
      }
    } catch {
      // ignore
    }
  }

  const hypersyncClient = new HypersyncClient({
    url: getHypersyncUrl(),
    apiToken: process.env.HYPERSYNC_API_KEY,
  });

  // Clamp to Hypersync indexed height (avoid “past archive” issues)
  let hypersyncHeight;
  try {
    hypersyncHeight = await hypersyncClient.getHeight();
  } catch {
    // ignore
  }
  let effectiveToBlock = toBlock;
  if (hypersyncHeight !== undefined) {
    const maxToBlock = hypersyncHeight + 1;
    if (effectiveToBlock !== undefined && effectiveToBlock > maxToBlock) {
      console.log(
        `Clamping TO_BLOCK from ${effectiveToBlock} to ${maxToBlock} (Hypersync height=${hypersyncHeight})`,
      );
      effectiveToBlock = maxToBlock;
    }
  } else if (effectiveToBlock !== undefined) {
    console.log(`Warning: unable to fetch Hypersync height; ignoring TO_BLOCK=${effectiveToBlock}`);
    effectiveToBlock = undefined;
  }

  const query = {
    fromBlock,
    toBlock: effectiveToBlock,
    transactions: [{ type: [TXN_TYPE] }],
    fieldSelection: {
      block: ["Number", "Timestamp", "Hash"],
      transaction: ["BlockNumber", "TransactionIndex", "Hash", "From", "Type", "AuthorizationList"],
    },
  };

  const buffers = new Map();
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
    }...`,
  );

  // Always use paginated get() in node runner (avoid Bun streaming crashes)
  const delayMs = process.env.HYPERSYNC_REQUEST_DELAY_MS
    ? Number(process.env.HYPERSYNC_REQUEST_DELAY_MS)
    : 200;
  const VERBOSE_PAGINATION = process.env.VERBOSE_PAGINATION === "true";
  const startedAt = Date.now();

  while (true) {
    if (VERBOSE_PAGINATION) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[${elapsed}s] hypersync.get(): fromBlock=${query.fromBlock}${
          query.toBlock ? ` toBlock=${query.toBlock}` : ""
        }`,
      );
    }
    const res = await hypersyncClient.get(query);
    if (VERBOSE_PAGINATION) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[${elapsed}s] hypersync.get() returned: nextBlock=${res.nextBlock} txns_in_batch=${res.data.transactions.length} archiveHeight=${res.archiveHeight ?? ""}`,
      );
      console.log(`[${elapsed}s] processing batch...`);
    }

    const batchStart = Date.now();
    for (const txn of res.data.transactions) {
      totalTxns++;
      const txFrom = txn.from ? normalizeAddress(txn.from) : undefined;
      const authList = txn.authorizationList;
      if (!authList || authList.length === 0) continue;

      totalAuths += authList.length;

      if (DEBUG_SAMPLE && debugPrinted < DEBUG_SAMPLE_LIMIT) {
        console.log("\n--- DEBUG_SAMPLE authorizationList[0] ---");
        console.log("tx.hash:", txn.hash);
        console.log("tx.from:", txn.from);
        console.log("tx.type:", txn.type);
        console.log("auth[0] keys:", Object.keys(authList[0] ?? {}));
        console.log(safeJsonPreview(authList[0]));
        debugPrinted++;
      }

      for (const auth of authList) {
        let authority;
        let recovered = false;
        try {
          authority = recoverAuthorityFromAuthorization(auth);
          recovered = true;
        } catch (e) {
          if (LOG_RECOVERY_FAILURES) {
            try {
              appendFileSync(
                RECOVERY_FAILURES_FILE,
                jsonLine({
                  txHash: txn.hash ?? null,
                  txFrom: txn.from ?? null,
                  chainId: auth?.chainId ?? null,
                  nonce: auth?.nonce ?? null,
                  yParity: auth?.yParity ?? null,
                  r: auth?.r ?? null,
                  s: auth?.s ?? null,
                  address: auth?.address ?? null,
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
            } catch {
              // ignore logging failures
            }
          }
          authority = txFrom;
        }
        if (!authority) continue;

        if (recovered) recoveredAuthority++;
        else fallbackToTxFrom++;

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

      if (DEBUG_SAMPLE && debugPrinted >= DEBUG_SAMPLE_LIMIT) break;
    }

    if (res.nextBlock) query.fromBlock = res.nextBlock;
    if (res.nextBlock) {
      try {
        writeFileSync(STATE_FILE, JSON.stringify({ nextBlock: res.nextBlock }, null, 2));
      } catch {
        // ignore
      }
    }

    const elapsed = (Date.now() - start) / 1000;
    if (elapsed - lastProgressLog >= 5) {
      console.log(
        `Progress: nextBlock=${res.nextBlock} txns=${totalTxns} auths=${totalAuths} elapsed=${elapsed.toFixed(
          1,
        )}s`,
      );
      lastProgressLog = elapsed;
    }

    if (
      (res.archiveHeight && res.nextBlock >= res.archiveHeight) ||
      (query.toBlock && res.nextBlock >= query.toBlock)
    ) {
      break;
    }

    if (DEBUG_SAMPLE && debugPrinted >= DEBUG_SAMPLE_LIMIT) break;
    if (VERBOSE_PAGINATION) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const batchElapsedMs = Date.now() - batchStart;
      console.log(
        `[${elapsed}s] batch processed in ${batchElapsedMs}ms: totals txns=${totalTxns} auths=${totalAuths} bufferedLines=${bufferedLines}`,
      );
    }
    if (delayMs > 0) {
      if (VERBOSE_PAGINATION) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[${elapsed}s] sleeping ${delayMs}ms before next request`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  flushBuffers(SHARD_DIR, buffers);
  console.log("Building deduped authority address list from shards...");
  const totalUnique = buildUniqueAddressFileFromShards(SHARD_DIR, OUTPUT_FILE);
  const elapsed = (Date.now() - start) / 1000;
  console.log(
    `Done. txns=${totalTxns} auths=${totalAuths} uniqueAuthorities=${totalUnique} elapsed=${elapsed.toFixed(
      1,
    )}s`,
  );
  console.log(
    `Authority recovery: recovered=${recoveredAuthority} fallback_to_tx_from=${fallbackToTxFrom} total_auths=${totalAuths}`,
  );
  console.log(`Wrote: ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

