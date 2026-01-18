import {
  HypersyncClient,
  type Query,
  type BlockField,
  type LogField,
  type TransactionField,
} from "@envio-dev/hypersync-client";
import { appendFileSync } from "node:fs";
import { recoverAuthorityFromAuthorization, type HypersyncAuthorization } from "./eip7702";

function loadDotEnvIfPresent(envPath = ".env") {
  try {
    const text = Bun.file(envPath).text();
    return text.then((raw) => {
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
    });
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

const FROM_BLOCK = 13514406;
const rawOutputPrefix = process.env.OUTPUT_PREFIX ?? process.env.CHAIN ?? "base";
const outputPrefix =
  rawOutputPrefix === "base" &&
  process.env.OUTPUT_PREFIX === undefined &&
  process.env.CHAIN === undefined
    ? ""
    : rawOutputPrefix;

function withPrefix(prefix: string, name: string) {
  return prefix ? `${prefix}-${name}` : name;
}

const OUTPUT_FILE = withPrefix(outputPrefix, "from-addresses.txt");
const OUTPUT_ALL_DELEGATED_FILE = withPrefix(outputPrefix, "delegated-addresses.txt");
const OUTPUT_WITHOUT_ADDOWNER_FILE = withPrefix(
  outputPrefix,
  "delegated-without-addowner.txt",
);
const OUTPUT_WITH_ADDOWNER_FILE = withPrefix(outputPrefix, "delegated-with-addowner.txt");

const TXN_TYPE = process.env.TXN_TYPE ? Number(process.env.TXN_TYPE) : 4;
const DEFAULT_TARGET_ADDRESSES =
  "0x000100abaad02f1cfC8Bbe32bD5a564817339E72,0x00000110dCdEdC9581cb5eCB8467282f2926534d";
const ADDOWNER_EVENT_TOPIC =
  "0x38109edc26e166b5579352ce56a50813177eb25208fd90d61f2f378386220220";

const fromBlock = process.env.FROM_BLOCK
  ? Number(process.env.FROM_BLOCK)
  : FROM_BLOCK;

const targetAddresses =
  (process.env.TARGET_ADDRESSES ?? DEFAULT_TARGET_ADDRESSES)
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

const SKIP_FETCH_TRANSACTIONS = process.env.SKIP_FETCH_TRANSACTIONS === "true";
const LOG_RECOVERY_FAILURES = process.env.LOG_RECOVERY_FAILURES === "true";
const RECOVERY_FAILURES_FILE = withPrefix(outputPrefix, "recovery-failures.jsonl");

async function main() {
  await loadDotEnvIfPresent();

  if (!process.env.HYPERSYNC_API_KEY) {
    throw new Error(
      "Missing HYPERSYNC_API_KEY. Set it in your environment before running.",
    );
  }

  const hypersyncClient = new HypersyncClient({
    url: getHypersyncUrl(),
    apiToken: process.env.HYPERSYNC_API_KEY,
  });

  let addressesArray: string[];

  if (SKIP_FETCH_TRANSACTIONS) {
    try {
      const addressesFile = await Bun.file(OUTPUT_FILE).text();
      addressesArray = addressesFile
        .trim()
        .split("\n")
        .filter((addr) => addr.length > 0);
      console.log(`Loaded ${addressesArray.length} addresses from ${OUTPUT_FILE}`);
    } catch (error) {
      console.error(`Error reading ${OUTPUT_FILE}:`, error);
      console.log("Set SKIP_FETCH_TRANSACTIONS to false to fetch transactions first.");
      return;
    }

    // Keep a stable, explicit copy of the full delegated address set for easy consumption.
    addressesArray = Array.from(
      new Set(addressesArray.map((a) => a.trim().toLowerCase()).filter(Boolean)),
    ).sort();
    await Bun.write(OUTPUT_ALL_DELEGATED_FILE, addressesArray.join("\n") + "\n");
    console.log(
      `Wrote ${addressesArray.length} delegated addresses to ${OUTPUT_ALL_DELEGATED_FILE}`,
    );
  } else {
    const query: Query = {
      fromBlock,
      transactions: [
        {
          type: [TXN_TYPE],
          authorizationList: [
            {
              address: targetAddresses,
            },
          ],
        },
      ],
      fieldSelection: {
        block: ["Number", "Timestamp", "Hash"] satisfies BlockField[],
        log: [
          "BlockNumber",
          "LogIndex",
          "TransactionIndex",
          "TransactionHash",
          "Data",
          "Address",
          "Topic0",
          "Topic1",
          "Topic2",
          "Topic3",
        ],
        transaction: [
          "BlockNumber",
          "TransactionIndex",
          "Hash",
          "From",
          "To",
          "Value",
          "Input",
          "AuthorizationList",
        ],
      },
    };

    console.log("Starting streaming query...");

    let totalTransactions = 0;
    const startTime = Date.now();
    const fromAddresses = new Set<string>();

    const stream = await hypersyncClient.stream(query, {});

    while (true) {
      const res = await stream.recv();

      if (!res) {
        console.log("Stream ended (null response)");
        break;
      }

      for (const txn of res.data.transactions) {
        totalTransactions++;

        // For EIP-7702 type-4, the delegated EOA is the authorization signer (authority),
        // which may differ from tx.from for sponsored transactions.
        const authList = (txn as any).authorizationList as any[] | undefined;
        if (authList && authList.length > 0) {
          for (const auth of authList) {
            try {
              const authority = recoverAuthorityFromAuthorization(auth as HypersyncAuthorization);
              fromAddresses.add(authority);
            } catch (e) {
              if (LOG_RECOVERY_FAILURES) {
                try {
                  appendFileSync(
                    RECOVERY_FAILURES_FILE,
                    JSON.stringify(
                      {
                        txHash: txn.hash ?? null,
                        txFrom: txn.from ?? null,
                        chainId: (auth as any)?.chainId ?? null,
                        nonce: (auth as any)?.nonce ?? null,
                        yParity: (auth as any)?.yParity ?? null,
                        r: (auth as any)?.r ?? null,
                        s: (auth as any)?.s ?? null,
                        address: (auth as any)?.address ?? null,
                        error: e instanceof Error ? e.message : String(e),
                      },
                      (_, v) => (typeof v === "bigint" ? v.toString() : v),
                    ) + "\n",
                  );
                } catch {
                  // ignore logging failures
                }
              }
              // Fall back to tx.from if signature recovery fails for any reason.
              if (txn.from) fromAddresses.add(txn.from.toLowerCase());
            }
          }
        } else if (txn.from) {
          fromAddresses.add(txn.from.toLowerCase());
        }

        console.log(`Transaction ${totalTransactions}:`, {
          hash: txn.hash,
          blockNumber: txn.blockNumber,
          from: txn.from,
          authorizationList: txn.authorizationList,
        });

        if (txn.authorizationList && txn.authorizationList.length > 0) {
          for (const auth of txn.authorizationList) {
            console.log("  Authorization:", auth);
          }
        }
      }

      if (res.nextBlock) {
        query.fromBlock = res.nextBlock;
      }

      if (
        (res.archiveHeight && res.nextBlock >= res.archiveHeight) ||
        (query.toBlock && res.nextBlock >= query.toBlock)
      ) {
        console.log(`Reached end of query. Final block: ${res.nextBlock}`);
        break;
      }

      const elapsed = (Date.now() - startTime) / 1000;
      console.log(
        `Progress: Block ${res.nextBlock} | ${totalTransactions} transactions | ${elapsed.toFixed(1)}s | ${(totalTransactions / elapsed).toFixed(1)} txns/s`,
      );
    }

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(
      `\nStreaming complete: ${totalTransactions} transactions processed in ${totalTime.toFixed(1)}s`,
    );

    addressesArray = Array.from(fromAddresses).sort();
    await Bun.write(OUTPUT_FILE, addressesArray.join("\n") + "\n");
    console.log(
      `\nWritten ${addressesArray.length} unique from addresses to ${OUTPUT_FILE}`,
    );

    await Bun.write(OUTPUT_ALL_DELEGATED_FILE, addressesArray.join("\n") + "\n");
    console.log(
      `Written ${addressesArray.length} delegated addresses to ${OUTPUT_ALL_DELEGATED_FILE}`,
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("Checking for AddOwner events...");
  console.log("=".repeat(80) + "\n");

  await checkAddOwnerEvents(hypersyncClient, addressesArray);
}

async function checkAddOwnerEvents(
  hypersyncClient: HypersyncClient,
  addresses: string[],
) {
  const results: Array<{
    address: string;
    hasAddOwner: boolean;
    events: number;
    eventDetails: Array<{
      blockNumber: bigint;
      txHash: string;
      index: string;
    }>;
  }> = [];

  console.log(`Checking ${addresses.length} addresses for AddOwner events...\n`);

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    console.log(`[${i + 1}/${addresses.length}] Checking ${address}...`);

    const query: Query = {
      fromBlock,
      logs: [
        {
          address: [address],
          topics: [[ADDOWNER_EVENT_TOPIC]],
        },
      ],
      fieldSelection: {
        log: [
          LogField.BlockNumber,
          LogField.TransactionHash,
          LogField.Data,
          LogField.Topic0,
          LogField.Topic1,
        ],
      },
    };

    const eventDetails: Array<{
      blockNumber: bigint;
      txHash: string;
      index: string;
    }> = [];

    try {
      const stream = await hypersyncClient.stream(query, {});

      while (true) {
        const res = await stream.recv();

        if (!res) {
          break;
        }

        for (const log of res.data.logs) {
          eventDetails.push({
            blockNumber: log.blockNumber!,
            txHash: log.transactionHash || "",
            index: log.topic1 || "",
          });
        }

        if (res.nextBlock) {
          query.fromBlock = res.nextBlock;
        }

        if (
          (res.archiveHeight && res.nextBlock >= res.archiveHeight) ||
          (query.toBlock && res.nextBlock >= query.toBlock)
        ) {
          break;
        }
      }
    } catch (error) {
      console.error(`  Error checking ${address}:`, error);
    }

    results.push({
      address,
      hasAddOwner: eventDetails.length > 0,
      events: eventDetails.length,
      eventDetails,
    });

    if (eventDetails.length > 0) {
      console.log(`  ✓ Found ${eventDetails.length} AddOwner event(s)`);
    } else {
      console.log("  ✗ No AddOwner found");
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const withAddOwner = results.filter((r) => r.hasAddOwner);
  const withoutAddOwner = results.filter((r) => !r.hasAddOwner);

  console.log(`\nAddresses WITH AddOwner event: ${withAddOwner.length}`);
  withAddOwner.forEach((r) => {
    console.log(`  ✓ ${r.address} (${r.events} event${r.events > 1 ? "s" : ""})`);
  });

  console.log(`\nAddresses WITHOUT AddOwner event: ${withoutAddOwner.length}`);
  withoutAddOwner.forEach((r) => {
    console.log(`  ✗ ${r.address}`);
  });

  const output = {
    totalAddresses: addresses.length,
    withAddOwner: withAddOwner.length,
    withoutAddOwner: withoutAddOwner.length,
    details: results,
  };

  await Bun.write("addowner-check-results.json", JSON.stringify(output, null, 2));
  console.log("\nResults written to addowner-check-results.json");

  await Bun.write(
    OUTPUT_WITH_ADDOWNER_FILE,
    withAddOwner.map((r) => r.address.toLowerCase()).sort().join("\n") + "\n",
  );
  await Bun.write(
    OUTPUT_WITHOUT_ADDOWNER_FILE,
    withoutAddOwner.map((r) => r.address.toLowerCase()).sort().join("\n") + "\n",
  );
  console.log(
    `Wrote ${withAddOwner.length} addresses to ${OUTPUT_WITH_ADDOWNER_FILE}`,
  );
  console.log(
    `Wrote ${withoutAddOwner.length} addresses to ${OUTPUT_WITHOUT_ADDOWNER_FILE}`,
  );
}

main();

