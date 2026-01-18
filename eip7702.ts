import {
  Signature,
  concat,
  encodeRlp,
  getAddress,
  getBytes,
  keccak256,
  recoverAddress,
  toBeHex,
} from "ethers";

export type HypersyncAuthorization = {
  chainId: string | number | bigint;
  address: string;
  nonce: string | number | bigint;
  yParity: string | number | bigint;
  r: string;
  s: string;
};

const MAGIC = Uint8Array.from([0x05]);

function parseUintBigint(value: unknown, field: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
    try {
      const n = s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
      if (n < 0n) throw new Error("negative");
      return n;
    } catch {
      throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
    }
  }
  throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
}

function isHexAddress(maybe: unknown): maybe is string {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{40}$/.test(maybe);
}

function normalizeHex32(value: unknown, field: "r" | "s"): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
  }
  const s = value.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(s)) {
    throw new Error(`Invalid ${field} in authorization: ${String(value)}`);
  }
  const hex = s.slice(2).toLowerCase().padStart(64, "0");
  return `0x${hex}`;
}

export function recoverAuthorityFromAuthorization(auth: HypersyncAuthorization): string {
  if (!isHexAddress(auth.address)) {
    throw new Error(`Invalid delegate address in authorization: ${String(auth.address)}`);
  }

  const chainId = parseUintBigint(auth.chainId, "chainId");
  const nonce = parseUintBigint(auth.nonce, "nonce");
  const yParityBig = parseUintBigint(auth.yParity, "yParity");
  if (yParityBig !== 0n && yParityBig !== 1n) {
    throw new Error(`Invalid yParity in authorization: ${String(auth.yParity)}`);
  }
  const yParity = Number(yParityBig) as 0 | 1;
  const r = normalizeHex32(auth.r, "r");
  const s = normalizeHex32(auth.s, "s");

  // Per EIP-7702: authority = ecrecover(keccak256(0x05 || rlp([chain_id, address, nonce])), yParity, r, s)
  //
  // ethers.encodeRlp expects each item to be bytes-like (or nested arrays). For integers, use the minimal
  // big-endian byte representation (0 is the empty string in RLP).
  const chainIdRlp = chainId === 0n ? "0x" : toBeHex(chainId);
  const nonceRlp = nonce === 0n ? "0x" : toBeHex(nonce);
  const rlp = encodeRlp([chainIdRlp, getAddress(auth.address), nonceRlp]);
  const digest = keccak256(concat([MAGIC, getBytes(rlp)]));
  const sig = Signature.from({ r, s, yParity });
  return recoverAddress(digest, sig).toLowerCase();
}

