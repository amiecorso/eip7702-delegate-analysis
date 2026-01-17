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

const MAGIC = Uint8Array.from([0x05]);

function isHex32(maybe) {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{64}$/.test(maybe);
}

function isHexAddress(maybe) {
  return typeof maybe === "string" && /^0x[0-9a-fA-F]{40}$/.test(maybe);
}

export function recoverAuthorityFromAuthorization(auth) {
  if (!isHexAddress(auth.address)) {
    throw new Error(`Invalid delegate address in authorization: ${String(auth.address)}`);
  }
  if (auth.yParity !== 0 && auth.yParity !== 1) {
    throw new Error(`Invalid yParity in authorization: ${String(auth.yParity)}`);
  }
  if (!isHex32(auth.r) || !isHex32(auth.s)) {
    throw new Error("Invalid r/s in authorization (expected 32-byte hex each)");
  }

  const chainIdRlp = auth.chainId === 0n ? "0x" : toBeHex(auth.chainId);
  const nonceRlp = auth.nonce === 0 ? "0x" : toBeHex(auth.nonce);
  const rlp = encodeRlp([chainIdRlp, getAddress(auth.address), nonceRlp]);
  const digest = keccak256(concat([MAGIC, getBytes(rlp)]));
  const sig = Signature.from({ r: auth.r, s: auth.s, yParity: auth.yParity });
  return recoverAddress(digest, sig).toLowerCase();
}

