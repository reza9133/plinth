// Computes the commitment for a sealed bid, the same way the contract does (keccak256 of a fixed text).
// Usage: node scripts/commit.mjs <slotId> <bidderAddress> <priceInWei> [salt]
// Keep the salt: you need it, with the price, to reveal. When no salt is given a random one is made.
import { randomBytes } from "node:crypto";
import { keccak256, toHex } from "viem";

export function commitment(slotId, bidder, amountWei, salt) {
  if (!/^\d+$/.test(String(slotId))) throw new Error("slotId must be a whole number");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(bidder))) throw new Error("bidder must be a 0x address with 40 hex digits");
  if (!/^\d+$/.test(String(amountWei))) throw new Error("the price must be a whole number of wei");
  if (!/^[A-Za-z0-9._~-]{8,64}$/.test(String(salt))) throw new Error("the salt needs 8 to 64 letters, digits or . _ ~ -");
  const text = `plinth:${slotId}:${String(bidder).toLowerCase()}:${amountWei}:${salt}`;
  return keccak256(toHex(text)).slice(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [slotId, bidder, amountWei, saltArg] = process.argv.slice(2);
  try {
    if (!slotId || !bidder || !amountWei) throw new Error("usage: node scripts/commit.mjs <slotId> <bidderAddress> <priceInWei> [salt]");
    const salt = saltArg ?? randomBytes(16).toString("hex");
    console.log(JSON.stringify({ slotId, bidder, price: amountWei, salt, commitment: commitment(slotId, bidder, amountWei, salt) }, null, 2));
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}
