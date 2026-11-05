// An in-memory stand-in for Studionet, used by `npm run live:sim` to test the live script itself (its flow, its model
// and its report) in seconds. It follows the rules of contracts/plinth.py, but it is NOT the contract: a green
// simulated run says nothing about the contract, only that the script is ready to be pointed at Studionet.
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [PENDING, CLEARED, UNSURE, REFUSED, VETOED] = [0, 1, 2, 3, 4];
const [OPEN, SETTLED, VOID, RELEASED, TAKEN_DOWN] = [0, 1, 2, 3, 4];
const [OUT_NONE, OUT_WON, OUT_LOST, OUT_EXCLUDED, OUT_FORFEITED] = [0, 1, 2, 3, 4];
const STEER = /ignore (?:all |any |the |every |your )?(?:previous|prior|above|earlier)\b|(?:mark|rate|score|set) (?:all |every |each )?(?:the )?(?:rules?|marks?) (?:as |to |at )?(?:met|0|zero)|"marks"\s*:/i;
const BAD = /guarantee|10x|cannot lose|never lose/i;

class UserError extends Error {}
const fail = (m) => {
  throw new UserError(m);
};

export async function createSimEnv({ quirk = false } = {}) {
  let clock = 1_800_000_000;
  const balances = new Map();
  const pending = [];
  const contracts = new Map();
  const receipts = new Map();
  let txCount = 0;
  let strictReads = 0;

  const bal = (a) => balances.get(a.toLowerCase()) ?? 0n;
  const setBal = (a, v) => balances.set(a.toLowerCase(), v);
  const now = () => Math.floor(clock);
  const tick = (s) => {
    clock += s;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at <= clock) {
        const t = pending.splice(i, 1)[0];
        setBal(t.to, bal(t.to) + t.amount);
      }
    }
  };

  function newContract() {
    return { slots: [], rounds: [], bids: [], seats: new Map(), owned: new Map(), entered: new Map(), c: { heldBids: 0n, heldEscrow: 0n, deposited: 0n, paid: 0n, volume: 0n, forfeits: 0n, settled: 0, void: 0, takedowns: 0, reads: 0 } };
  }

  const emit = (addr, to, amount) => {
    setBal(addr, bal(addr) - amount);
    pending.push({ to, amount, at: clock + 20 });
  };

  const phaseOf = (r) => {
    if (r.stage !== OPEN) return "FINAL";
    const n = now();
    return n < r.bid_end ? "BID" : n < r.review_end ? "REVIEW" : n < r.reveal_end ? "REVEAL" : "SETTLE";
  };
  const need = (r, ph) => {
    if (phaseOf(r) !== ph) fail(`That is only possible during the ${ph.toLowerCase()} phase of the round.`);
  };

  function marksFor(creative, lenient) {
    if (BAD.test(creative)) return [1, 2, 0];
    if (quirk) {
      if (lenient) return [1, 0, 0];
      strictReads++;
      if (strictReads === 1) return [1, 0, 0];
      if (strictReads === 2) return [0, 2, 0];
    }
    return [0, 0, 0];
  }
  const verdict = (marks, lenient) => (marks.includes(2) ? REFUSED : lenient ? UNSURE : marks.every((m) => m === 0) ? CLEARED : UNSURE);

  const slotRow = (K, id) => {
    const s = K.slots[id];
    return { id, curator: s.curator, beneficiary: s.beneficiary, name: s.name, rules: s.rules.split("\n"), created: s.created, paused: s.paused, max_bid: String(s.max_bid), reserve: String(s.reserve), hold: s.hold, bid_secs: s.bid_secs, review_secs: s.review_secs, reveal_secs: s.reveal_secs, forfeit_bps: s.forfeit_bps, rounds: s.rounds.length, showing: s.showing - 1 };
  };
  const roundRow = (K, id) => {
    const r = K.rounds[id];
    return { id, slot: r.slot, index: r.index, stage: r.stage, phase: phaseOf(r), opened: r.opened, bid_end: r.bid_end, review_end: r.review_end, reveal_end: r.reveal_end, shown_until: r.shown_until, settled_at: r.settled_at, beneficiary: r.beneficiary, bids: r.bid_ids.length, winner: r.winner - 1, price: String(r.price), escrow: String(r.escrow), valid: r.n_valid, note: r.note || null };
  };
  const bidRow = (K, id) => {
    const b = K.bids[id];
    return { id, slot: b.slot, round: b.round, bidder: b.bidder, creative: b.creative, link: b.link || null, commit: b.commit, deposit: String(b.deposit), created: b.created, gate: b.gate, by: b.by, tries: b.tries, review: b.review, appealed: b.appealed, appeal_note: b.appeal_note || null, veto_note: b.veto_note || null, revealed: b.revealed, amount: String(b.amount), outcome: b.outcome, refunded: String(b.refunded), forfeited: String(b.forfeited), paid: String(b.paid) };
  };

  function exec(K, self, sender, fn, args, value) {
    const me = sender.toLowerCase();
    const payable = fn === "bid";
    if (!payable && value !== 0n) fail("This method does not accept GEN.");
    const S = (id) => K.slots[id] ?? fail("There is no such slot.");
    const B = (id) => K.bids[id] ?? fail("There is no such bid.");
    const page = (arr, offset, limit, rowOf) => {
      const out = [];
      let i = arr.length - 1 - Math.max(0, offset);
      while (i >= 0 && out.length < Math.min(50, limit)) out.push(rowOf(arr[i--]));
      return out;
    };
    switch (fn) {
      case "create_slot": {
        const [name, rules, max_bid, reserve, hold, bid_secs, review_secs, reveal_secs, forfeit_bps, beneficiary] = args;
        const parsed = String(rules).split("|").map((x) => x.trim()).filter(Boolean);
        if (parsed.length < 1 || parsed.length > 5) fail("A slot has 1 to 5 rules.");
        if (max_bid < 10n ** 15n || reserve < 10n ** 15n || reserve > max_bid) fail("Bad prices.");
        for (const sp of [bid_secs, review_secs, reveal_secs, hold]) if (sp < 60) fail("Each phase has to last at least 1 minute.");
        if (forfeit_bps < 500 || forfeit_bps > 5000) fail("The forfeit has to be between 5% and 50%.");
        const id = K.slots.length;
        K.slots.push({ curator: me, beneficiary: String(beneficiary).toLowerCase() || me, name, rules: parsed.join("\n"), created: now(), paused: false, max_bid, reserve, hold, bid_secs, review_secs, reveal_secs, forfeit_bps, rounds: [], showing: 0 });
        if (!K.owned.has(me)) K.owned.set(me, []);
        K.owned.get(me).push(id);
        return id;
      }
      case "bid": {
        const [slotId, creative, link, commitment] = args;
        const s = S(slotId);
        if (s.paused) fail("The slot is paused.");
        if (me === s.curator || me === s.beneficiary) fail("The curator and the beneficiary cannot bid.");
        if (value !== s.max_bid) fail("Send exactly the slot's deposit, which is its highest allowed bid.");
        const text = String(creative).split(/\s+/).join(" ");
        if (text.length < 8 || text.length > 280) fail("The message needs 8 to 280 characters.");
        if (!/^[0-9a-f]{64}$/.test(String(commitment).toLowerCase())) fail("The commitment has to be 64 hex characters.");
        const total = s.bid_secs + s.review_secs + s.reveal_secs;
        let roundId = -1;
        if (s.rounds.length > 0) {
          const last = s.rounds[s.rounds.length - 1];
          const prev = K.rounds[last];
          if (prev.stage === OPEN) {
            if (now() >= prev.bid_end) fail("Bidding for this round is closed. The next round opens after it is settled.");
            roundId = last;
          } else if (now() + total < prev.shown_until) fail("The winner is on display.");
        }
        if (roundId >= 0) {
          if (K.seats.has(`${roundId}:${me}`)) fail("You already have a bid in this round.");
        } else {
          roundId = K.rounds.length;
          const bid_end = now() + s.bid_secs;
          const review_end = bid_end + s.review_secs;
          K.rounds.push({ slot: slotId, index: s.rounds.length, stage: OPEN, opened: now(), bid_end, review_end, reveal_end: review_end + s.reveal_secs, shown_until: 0, settled_at: 0, beneficiary: s.beneficiary, bid_ids: [], winner: 0, price: 0n, escrow: 0n, n_valid: 0, note: "" });
          s.rounds.push(roundId);
        }
        const id = K.bids.length;
        K.bids.push({ slot: slotId, round: roundId, bidder: me, creative: text, link: link || "", commit: String(commitment).toLowerCase(), deposit: value, created: now(), gate: PENDING, by: 0, tries: 0, review: null, appealed: false, appeal_note: "", veto_note: "", revealed: false, amount: 0n, outcome: OUT_NONE, refunded: 0n, forfeited: 0n, paid: 0n });
        K.rounds[roundId].bid_ids.push(id);
        K.seats.set(`${roundId}:${me}`, id + 1);
        if (!K.entered.has(me)) K.entered.set(me, []);
        K.entered.get(me).push(id);
        K.c.heldBids += value;
        K.c.deposited += value;
        return id;
      }
      case "screen": {
        const b = B(args[0]);
        const r = K.rounds[b.round];
        need(r, "REVIEW");
        if (b.gate !== PENDING) fail("This bid has been read already.");
        K.c.reads++;
        if (STEER.test(b.creative)) {
          b.gate = REFUSED;
          b.by = 1;
          b.review = { mode: "strict", kind: "TRIPWIRE", marks: [], reason: "The message tries to instruct the gate." };
          return null;
        }
        const marks = marksFor(b.creative, false);
        b.gate = verdict(marks, false);
        b.by = 1;
        b.review = { mode: "strict", kind: "OK", marks, reason: "simulated read" };
        return null;
      }
      case "appeal": {
        const b = B(args[0]);
        if (me !== b.bidder) fail("Only the bidder can appeal.");
        need(K.rounds[b.round], "REVIEW");
        if (b.gate !== REFUSED) fail("Only a refusal by the gate can be appealed.");
        if (b.appealed) fail("This bid has been appealed already.");
        if (String(args[1]).length < 8) fail("The note needs 8 to 200 characters.");
        const marks = marksFor(b.creative, true);
        b.appealed = true;
        b.appeal_note = args[1];
        b.gate = verdict(marks, true);
        b.by = 1;
        b.review = { mode: "appeal", kind: "OK", marks, reason: "simulated appeal" };
        K.c.reads++;
        return null;
      }
      case "clear": {
        const b = B(args[0]);
        if (me !== K.slots[b.slot].curator) fail("Only the curator can do that.");
        need(K.rounds[b.round], "REVIEW");
        if (b.gate !== UNSURE) fail("Only a bid the gate was unsure about can be cleared.");
        b.gate = CLEARED;
        b.by = 2;
        return null;
      }
      case "veto": {
        const b = B(args[0]);
        if (me !== K.slots[b.slot].curator) fail("Only the curator can do that.");
        need(K.rounds[b.round], "REVIEW");
        if (![PENDING, CLEARED, UNSURE].includes(b.gate)) fail("This bid is out already.");
        if (String(args[1]).length < 8) fail("The note needs 8 to 200 characters.");
        b.gate = VETOED;
        b.by = 2;
        b.veto_note = args[1];
        return null;
      }
      case "reveal": {
        const [bidId, amount, salt] = args;
        const b = B(bidId);
        const s = K.slots[b.slot];
        if (me !== b.bidder) fail("Only the bidder can reveal.");
        need(K.rounds[b.round], "REVEAL");
        if (b.gate !== CLEARED) fail("Only a bid whose message was cleared can reveal a price.");
        if (b.revealed) fail("This bid has been revealed already.");
        if (amount < s.reserve || amount > s.max_bid) fail("The price is outside the slot's range.");
        const c = keccak256(toHex(`plinth:${b.slot}:${b.bidder}:${amount}:${salt}`)).slice(2);
        if (c !== b.commit) fail("The price and the salt do not match the commitment.");
        b.revealed = true;
        b.amount = amount;
        return null;
      }
      case "settle": {
        const s = S(args[0]);
        if (s.rounds.length === 0) fail("There is nothing to settle.");
        const roundId = s.rounds[s.rounds.length - 1];
        const r = K.rounds[roundId];
        if (r.stage !== OPEN) fail("There is nothing to settle.");
        if (now() < r.reveal_end) fail("The round is not over yet.");
        let best = -1, bestAmt = -1n, second = -1n, n = 0;
        for (const id of r.bid_ids) {
          const b = K.bids[id];
          if (b.gate === CLEARED && b.revealed) {
            n++;
            if (b.amount > bestAmt) { second = bestAmt; best = id; bestAmt = b.amount; } else if (b.amount > second) second = b.amount;
          }
        }
        const price = best >= 0 ? (n >= 2 ? second : s.reserve) : 0n;
        let payBack = 0n, payFees = 0n, released = 0n;
        for (const id of r.bid_ids) {
          const b = K.bids[id];
          released += b.deposit;
          let back = b.deposit;
          if (id === best) { back = b.deposit - price; b.outcome = OUT_WON; b.paid = price; }
          else if (b.gate === CLEARED && b.revealed) b.outcome = OUT_LOST;
          else if (b.gate === CLEARED) { const fee = (b.deposit * BigInt(s.forfeit_bps)) / 10000n; back = b.deposit - fee; payFees += fee; b.forfeited = fee; b.outcome = OUT_FORFEITED; }
          else b.outcome = OUT_EXCLUDED;
          b.refunded = back;
          payBack += back;
          if (back > 0n) emit(self, b.bidder, back);
        }
        if (payFees > 0n) emit(self, r.beneficiary, payFees);
        K.c.heldBids -= released;
        K.c.paid += payBack + payFees;
        K.c.forfeits += payFees;
        r.n_valid = n;
        r.settled_at = now();
        if (best >= 0) {
          r.stage = SETTLED; r.winner = best + 1; r.price = price; r.escrow = price; r.shown_until = now() + s.hold; s.showing = roundId + 1;
          K.c.heldEscrow += price; K.c.settled++;
        } else { r.stage = VOID; K.c.void++; }
        return null;
      }
      case "release": {
        const r = K.rounds[args[0]] ?? fail("There is no such round.");
        if (r.stage !== SETTLED) fail("There is no display to release.");
        if (now() < r.shown_until) fail("The display has not ended yet.");
        const amount = r.escrow;
        r.escrow = 0n; r.stage = RELEASED;
        K.c.heldEscrow -= amount; K.c.paid += amount; K.c.volume += amount;
        if (amount > 0n) emit(self, r.beneficiary, amount);
        return null;
      }
      case "takedown": {
        const r = K.rounds[args[0]] ?? fail("There is no such round.");
        const s = K.slots[r.slot];
        if (me !== s.curator) fail("Only the curator can do that.");
        if (r.stage !== SETTLED || now() >= r.shown_until) fail("There is no display to take down.");
        if (String(args[1]).length < 8) fail("The note needs 8 to 200 characters.");
        const price = r.escrow;
        const left = BigInt(r.shown_until - now());
        const refund = (price * left) / BigInt(s.hold);
        const earned = price - refund;
        const winner = K.bids[r.winner - 1];
        r.escrow = 0n; r.stage = TAKEN_DOWN; r.shown_until = now(); r.note = args[1];
        K.c.heldEscrow -= price; K.c.paid += price; K.c.volume += earned; K.c.takedowns++;
        if (refund > 0n) emit(self, winner.bidder, refund);
        if (earned > 0n) emit(self, r.beneficiary, earned);
        return null;
      }
      // ---- views
      case "stats":
        return JSON.stringify({ slots: K.slots.length, rounds: K.rounds.length, bids: K.bids.length, settled: K.c.settled, void: K.c.void, takedowns: K.c.takedowns, reads: K.c.reads, volume: String(K.c.volume), forfeits: String(K.c.forfeits), deposited: String(K.c.deposited), paid: String(K.c.paid) });
      case "solvency":
        return JSON.stringify({ deposited: String(K.c.deposited), paid: String(K.c.paid), deposits_held: String(K.c.heldBids), escrow_held: String(K.c.heldEscrow), balanced: K.c.deposited - K.c.paid === K.c.heldBids + K.c.heldEscrow });
      case "get_slot": S(args[0]); return JSON.stringify(slotRow(K, args[0]));
      case "slots_of": return JSON.stringify(page(K.owned.get(String(args[0]).toLowerCase()) ?? [], args[1], args[2], (i) => slotRow(K, i)));
      case "get_round": return JSON.stringify(roundRow(K, K.rounds[args[0]] ? args[0] : fail("There is no such round.")));
      case "get_bid": B(args[0]); return JSON.stringify(bidRow(K, args[0]));
      case "bids_of": return JSON.stringify(page(K.entered.get(String(args[0]).toLowerCase()) ?? [], args[1], args[2], (i) => bidRow(K, i)));
      case "bids_of_round": {
        const r = K.rounds[args[0]] ?? fail("There is no such round.");
        return JSON.stringify(r.bid_ids.slice(Math.max(0, args[1]), Math.max(0, args[1]) + Math.min(50, args[2])).map((i) => bidRow(K, i)));
      }
      case "current": {
        const s = S(args[0]);
        if (s.showing > 0) {
          const r = K.rounds[s.showing - 1];
          if (r.stage === SETTLED && now() < r.shown_until) {
            const b = K.bids[r.winner - 1];
            return JSON.stringify({ occupied: true, slot: args[0], round: s.showing - 1, bid: r.winner - 1, bidder: b.bidder, creative: b.creative, link: b.link, price: String(r.price), from: r.settled_at, until: r.shown_until });
          }
        }
        return JSON.stringify({ occupied: false, slot: args[0] });
      }
      case "status": {
        const s = S(args[0]);
        const total = s.bid_secs + s.review_secs + s.reveal_secs;
        let phase = "IDLE", round = -1, ends_at = 0, opens_at = 0;
        if (s.rounds.length > 0) {
          round = s.rounds[s.rounds.length - 1];
          const r = K.rounds[round];
          if (r.stage === OPEN) { phase = phaseOf(r); ends_at = { BID: r.bid_end, REVIEW: r.review_end, REVEAL: r.reveal_end, SETTLE: 0 }[phase]; }
          else { opens_at = Math.max(0, r.shown_until - total); if (opens_at <= now()) opens_at = 0; }
        }
        return JSON.stringify({ slot: args[0], paused: s.paused, phase, round, ends_at, opens_at, can_bid: phase === "BID" || (phase === "IDLE" && opens_at === 0), now: now() });
      }
      case "commitment_for": S(args[0]); return keccak256(toHex(`plinth:${args[0]}:${String(args[1]).toLowerCase()}:${args[2]}:${args[3]}`)).slice(2);
      default: fail(`unknown method ${fn}`);
    }
  }

  function makeClient(account) {
    const sender = account?.address ?? "0x0000000000000000000000000000000000000000";
    return {
      async writeContract({ address, functionName, args = [], value = 0n }) {
        tick(4); // a transaction takes a few seconds to be decided
        const K = contracts.get(address.toLowerCase());
        const hash = "0x" + (++txCount).toString(16).padStart(64, "0");
        let receipt;
        try {
          if (value > bal(sender)) fail("insufficient funds");
          const out = exec(K, address.toLowerCase(), sender, functionName, args, value);
          if (value > 0n) setBal(sender, bal(sender) - value);
          receipt = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_RETURN", data: { result: out } };
        } catch (err) {
          if (!(err instanceof UserError)) throw err;
          receipt = { statusName: "ACCEPTED", txExecutionResultName: "FINISHED_WITH_ERROR", data: { message: err.message } };
        }
        receipts.set(hash, receipt);
        return hash;
      },
      async readContract({ address, functionName, args = [] }) {
        const K = contracts.get(address.toLowerCase());
        return exec(K, address.toLowerCase(), sender, functionName, args, 0n);
      },
    };
  }

  return {
    mode: "simulated",
    rpc: "in-memory simulation (not a network)",
    reader: makeClient(null),
    // Sleeping moves the simulated clock, so a ten-minute round takes no time at all.
    sleep: async (ms) => tick(ms / 1000),
    nowMs: () => clock * 1000,
    newAccount() {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      return { account, key, address: account.address };
    },
    makeClient,
    async fund(address, wei = "1000000000000000000") {
      setBal(address, bal(address) + BigInt(wei));
      return { ok: true };
    },
    async deployContract() {
      const address = "0x" + (contracts.size + 1).toString(16).padStart(40, "0");
      contracts.set(address, newContract());
      return { address, hash: "0x" + "d".repeat(64) };
    },
    async balance(address) {
      tick(0);
      return bal(address);
    },
    async waitTx(_client, hash) {
      return receipts.get(hash);
    },
  };
}
