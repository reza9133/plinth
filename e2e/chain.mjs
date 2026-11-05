// The real Studionet environment for the live run. The simulated one (e2e/sim.mjs) has the same shape, so the
// scenarios in live.mjs do not know which of them they run on.
import { deploy } from "../scripts/deploy.mjs";

export const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createLiveEnv() {
  const sdk = await import("genlayer-js");
  const { studionet } = await import("genlayer-js/chains");
  const rpc = studionet?.rpcUrls?.default?.http?.[0];
  const reader = sdk.createClient({ chain: studionet });

  async function rawBalance(address) {
    try {
      if (typeof reader.getBalance === "function") return BigInt(await reader.getBalance({ address }));
    } catch {
      /* fall through to the plain RPC call */
    }
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
      });
      const out = await res.json();
      return out?.result != null ? BigInt(out.result) : null;
    } catch {
      return null;
    }
  }

  return {
    mode: "live",
    rpc,
    reader,
    sleep: sleepReal,
    nowMs: () => Date.now(),
    newAccount() {
      const key = sdk.generatePrivateKey();
      const account = sdk.createAccount(key);
      return { account, key, address: account.address };
    },
    makeClient: (account) => sdk.createClient({ chain: studionet, account }),
    async fund(address, wei = "1000000000000000000") {
      // The number is written by hand because JSON.stringify cannot carry a BigInt (same as scripts/keys.mjs).
      const body = `{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["${address}",${wei}]}`;
      try {
        const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body });
        const out = await res.json();
        if (out.error) throw new Error(out.error.message ?? JSON.stringify(out.error));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err).slice(0, 160) };
      }
    },
    async deployContract(key) {
      const { address, hash } = await deploy(key);
      return { address, hash };
    },
    balance: rawBalance,
    // Waits for a decided transaction; never throws for a timeout, the caller decides what "not decided" means.
    async waitTx(client, hash) {
      return client.waitForTransactionReceipt({ hash, status: "ACCEPTED", retries: 400, interval: 3000 });
    },
  };
}
