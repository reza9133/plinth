# Plinth

**A sealed-bid auction for a public slot, with an AI gatekeeper that never sees a price.**

A curator opens a *slot*: a public pedestal that shows one short message at a time, with a few plain-language rules
about what may stand on it. Anyone can bid for the next turn by committing to a secret price and locking a fixed
deposit. Before a single price is revealed, an AI gate (run by the validators) reads every message against the
slot's rules, and the curator can veto. Only then do the cleared bidders reveal their prices. The highest price wins
and pays the *second-highest* price, so the honest bid is simply "what is this turn worth to me". The winner's message
goes on display, the price waits in escrow while it is there and is paid to the beneficiary when the display ends.

It is a GenLayer intelligent contract (`contracts/plinth.py`, one file, no dependencies) written for **Studionet**.

> The model reads the words and never sees the money. The contract counts the money and never reads a word.

## Why it is built this way

An AI that can touch prices or funds is an AI that can be talked into a mistake that costs real money. Plinth splits
the work so that the model's mistakes are cheap:

| Layer | Decides | Can it be talked into a mistake? |
| --- | --- | --- |
| Deterministic shell | deposits, price range, who wins, what the winner pays, refunds, forfeits, timing, who may call what | No. It is code. |
| AI gate | whether a message complies with each rule of the slot | Maybe, so it can only *remove* a bid, never add one or touch a price |
| Curator | veto during review, decide what the gate was unsure about, take a display down | Human |
| Everyone | ask for the gate's read, appeal a refusal once, settle and release | n/a |

What follows from that split:

* **The gate never sees a price, a commitment, a deposit or an address.** A message is judged on its words only, so
  nobody can buy a favourable reading and the curator cannot trim bids by price (the prices are still sealed during
  review).
* **Every bid has the same deposit** (the slot's highest allowed price), so deposits leak nothing about prices.
* **Whatever the model says, the money follows arithmetic.** Clear everything and nobody pays more than the second
  price; refuse everything and every deposit comes back untouched.
* **The model can only move a bid towards "no".** A refusal can be appealed once, and an appeal can only turn it into
  "unsure", which a human settles. Nothing the model does can clear a bid that the first read did not clear.
* **Validators lean towards "no" as well.** A validator accepts the leader's read only if it is as strict as its own, or
  exactly one step stricter, never milder (details below).
* **The curator can end a display early but cannot keep the money.** The unused part of the price goes back to the
  winner.

## Roles

| Role | Can | Cannot |
| --- | --- | --- |
| **Curator** (whoever created the slot) | veto bids, clear what the gate was unsure about, take a display down, pause the slot, change the beneficiary for future rounds | bid, see a price before the reveal, overrule a refusal, touch a deposit or a price |
| **Beneficiary** (defaults to the curator) | receive prices and forfeits | bid |
| **Bidder** | place one sealed bid per round, appeal a refusal once, reveal | clear, veto, settle in a special way (anyone can settle) |
| **Anyone** | ask the gate to read a bid, settle a finished round, release a finished display | change a result |

## Life of a round

A round is created by the first bid after the previous round has been settled and (if a winner is on display) the
display is about to end. Its three phases last as long as the curator set them:

```
 BID phase                REVIEW phase                  REVEAL phase                 settle (anyone)
 -----------------------  ----------------------------  ---------------------------  ---------------------------
 bid(): message + sealed  screen():  AI gate reads the  reveal(): cleared bidders      highest price wins, pays the
 price commitment + the   message against every rule    show their price and salt      second-highest (or the reserve
 fixed deposit            appeal():  once, refused ->   (the contract checks the        when alone). Everybody else
                          unsure     only                hash)                          gets the deposit back; a cleared
                          clear()/veto(): curator                                      bid that never revealed loses
                                                                                       part of it.
                                                                                      |
                                                                                      v
                                                                       the winner is on display for `hold` seconds
                                                                       release(): price -> beneficiary when it ends
                                                                       takedown(): curator ends it early, the unused
                                                                                   part of the price goes back
```

A bid's *gate* moves like this:

```
PENDING --screen--> CLEARED  (every rule met)                 -> may reveal
        |        -> UNSURE   (anything unclear) --clear--> CLEARED (curator)     (if nobody acts: out, deposit back)
        |        -> REFUSED  (a rule broken, or the tripwire) --appeal--> UNSURE   (never CLEARED)
        +--veto--> VETOED    (curator, final)
```

A bid that is not CLEARED when the review phase ends can not reveal and simply gets its deposit back at settle.

### Money

| Event | What happens |
| --- | --- |
| `bid` | exactly `max_bid` is locked (anything else is refused) |
| `settle` | winner: the price goes into escrow, the rest of the deposit is sent back. Cleared and revealed losers: whole deposit back. Excluded bids (refused, unsure, vetoed, never read): whole deposit back. Cleared bids that never revealed: `forfeit_bps` of the deposit goes to the beneficiary, the rest back. |
| `release` | the display is over: the escrowed price goes to the beneficiary |
| `takedown` | the curator ends the display: `price * time_left / hold` goes back to the winner, the rest to the beneficiary |

`solvency()` reports the books: everything ever paid in equals everything paid out plus the deposits of open rounds plus
the prices in escrow.

## Sealed bids

A bid carries a commitment: the keccak-256 hash (Keccak from the GenVM SDK, so every validator computes the same
thing) of this text, with the address in lower case, the price in wei and your own random salt:

```
plinth:<slot id>:<bidder address, lower case>:<price in wei>:<salt>
```

The salt has 8 to 64 characters from `A-Z a-z 0-9 . _ ~ -`. The bidder's address is part of the hash, so nobody can copy
somebody else's commitment, and the slot id keeps a commitment from being replayed elsewhere. Use a fresh salt for every
bid; a reused salt tells everyone the price you revealed earlier.

Three ways to compute it:

```bash
node scripts/commit.mjs <slotId> <yourAddress> <priceInWei> [salt]     # prints the salt and the commitment as JSON
```

```js
import { keccak256, toHex } from "viem";
const commitment = keccak256(toHex(`plinth:${slot}:${address.toLowerCase()}:${priceWei}:${salt}`)).slice(2);
```

or call the view `commitment_for(slot, bidder, price, salt)` (convenient, but whatever you pass to a view is visible to
the node that serves it, so prefer computing it yourself for a real bid). The price has to be between the slot's
`reserve` and `max_bid`; a bid that committed to anything else can never reveal.

## The gate

A slot has 1 to 5 rules, plain sentences of 8 to 140 characters (for example *"Make no promise of returns or
guaranteed profit"*). For every rule the model gives one mark: `0` complies, `1` unsure, `2` clearly breaks the rule.
The **contract** turns the marks into a verdict:

| Marks | Verdict |
| --- | --- |
| all `0` | **CLEARED** |
| any `2` | **REFUSED** |
| otherwise | **UNSURE** (the curator can clear it during the review phase) |

The prompt carries the rules and the message and nothing else. The message is wrapped in a tag and has its angle
brackets stripped, and the model is told to treat it as data. On top of that sits a small *tripwire*: a message that
contains an obvious instruction to the gate ("ignore all previous instructions", "mark every rule as met", a pasted
`"marks": [...]`, and so on) is refused without asking the model at all. The tripwire is not the defence. The defence
is the structure: the worst a successful injection can do is get a bid cleared, the curator can still veto it, a
cleared bid still has to win on price, and the price is paid by the bidder.

**Unreadable answers** (not JSON, wrong number of marks, a mark that is not 0, 1 or 2) leave the bid waiting. After two
minutes anyone can ask again; three unreadable reads in a row make the bid UNSURE, so a human decides.

**Appeals.** The bidder of a refused bid can appeal once, with a note of 8 to 200 characters. An *appeals reader* looks
again, more generously (a rule only counts as broken when no reasonable reading complies). If it still finds a broken
rule the refusal stands; otherwise the bid becomes UNSURE, never CLEARED. The note is shown to the model as an argument,
inside its own tag; a note that tries to instruct the reader is refused.

**Validators.** The leader reads the message; every validator reads it again and compares. The validator works out the
verdict from the leader's marks itself (a leader cannot report a verdict its marks do not support) and accepts when the
leader's verdict is the same as its own or exactly one step stricter (`CLEARED < UNSURE < REFUSED`). A milder leader, or
one that is two steps apart, is rejected. Two unreadable answers agree with each other; a leader that read something the
validator could not, or the other way round, does not. Marks have to be exactly the integers 0, 1 and 2, and the reason
has to be plain text of at most 160 characters.

## Methods

Write methods (everything except `bid` is refused if value is attached to it):

| Method | Who | What |
| --- | --- | --- |
| `create_slot(name, rules, max_bid, reserve, hold_secs, bid_secs, review_secs, reveal_secs, forfeit_bps, beneficiary)` | anyone | open a slot; rules are separated by `\|`; empty beneficiary = the sender |
| `set_paused(slot, paused)` | curator | stop or allow new bids (a running round carries on) |
| `set_beneficiary(slot, who)` | curator | applies to rounds that open from now on |
| `bid(slot, creative, link, commitment)` *(payable)* | bidder | send exactly `max_bid`; message of 8 to 280 characters; optional public http(s) link (shown, never fetched) |
| `screen(bid)` | anyone | the AI gate reads a bid (review phase) |
| `appeal(bid, note)` | bidder | one more generous read of a refused bid; can only lead to UNSURE |
| `clear(bid)` / `veto(bid, note)` | curator | review phase: clear an UNSURE bid / remove a bid |
| `reveal(bid, price, salt)` | bidder | reveal phase, cleared bids only |
| `settle(slot)` | anyone | after the reveal phase: pick the winner, return deposits |
| `release(round)` | anyone | after the display: pay the beneficiary |
| `takedown(round, note)` | curator | end a display early with a pro-rata refund |

Views (all return JSON text): `stats`, `solvency`, `get_slot`, `list_slots(offset, limit)`, `slots_of(who, offset, limit)`,
`get_round`, `rounds_of(slot, offset, limit)`, `get_bid`, `bids_of_round(round, offset, limit)`,
`bids_of(who, offset, limit)`, `current(slot)` (what is on display now), `status(slot)` (phase, when it ends, whether a
bid would be accepted now), `commitment_for(slot, bidder, price, salt)`. Pages are at most 50 rows. Amounts are strings
(wei).

## Limits

| What | Value |
| --- | --- |
| Highest bid / lowest price | 0.001 to 1,000,000 GEN (the reserve is at least 0.001 GEN and at most the highest bid) |
| Each of the bid, review and reveal phases | 1 minute to 14 days |
| Display time | 1 minute to 30 days |
| Forfeit for a cleared bid that never reveals | 5% to 50% of the deposit |
| Bids per round | 16 (one per address) |
| Rules per slot | 1 to 5, of 8 to 140 characters |
| Message / note / link | 8 to 280 / 8 to 200 / up to 200 characters |

## What it does not do (read before trusting it with value)

* **Sybil bidders can fill a round.** A round takes 16 bids, one per address. Someone with 16 addresses and
  16 deposits can occupy the round (the deposits come back, so it costs only the capital's time). Use a short bid phase
  and keep the deposit meaningful; there is no entry fee.
* **A curator can still cheat through the review.** The curator may veto any bid (and so can decide who is in), and a
  curator who also owns a bidder address can win their own slot by paying the beneficiary. The curator and the
  beneficiary of a round cannot bid, but a second address is not detectable. Treat a slot's curator as the owner of the
  slot, not as a neutral party.
* **Second price is not shill-proof.** A bidder that is secretly the seller can raise the price a winner pays. Sealed
  prices and equal deposits make this hard (the shill has to guess), not impossible.
* **A late settle delays the display.** Settling is the moment the winner appears and the display clock starts; anyone
  can settle once the reveal phase is over, and every loser has a deposit waiting for it, so someone will.
* **The model can be wrong.** It can clear a message that breaks a rule (the curator's veto and `takedown` are the
  remedy) or refuse one that complies (appeal, then the curator). It can not change a price or a deposit.
* **No link is ever fetched.** The link on a bid is displayed only; the gate judges the words of the message.
* **One live run on Studionet so far.** The suite below runs locally with a mocked model. A live run against the
  deployed contract (see `reports/live-report.md`, 2026-11-06) passed all its hard checks, but it is one run with a live
  model whose answers vary: the gate read one compliant message as UNSURE and the curator path was used. Treat the
  gate's reading quality as something to watch, not as settled.

## Tests

```bash
bash scripts/setup.sh                # python and node packages
genvm-lint check contracts/plinth.py # the GenVM linter
python -m pytest -q                  # the direct-mode suite (no network, no node needed)
```

The suite runs the contract in `genlayer-test`'s direct mode with the model mocked. It covers the helpers (text,
links, rules, tripwire, commitment against independent Keccak vectors), slot and bid validation (every refused call is
checked to leave the contract exactly as it was), the gate (every outcome, unreadable answers and retries, appeals),
the validator rule (exhaustively over all mark combinations), settle, release and takedown with exact amounts,
adversarial inputs, and seeded random walks that call everything in any order while a separate model checks the books
after every call.

420 tests pass: 409 direct tests plus 11 seeded random walks (the walks reach settled winners, void rounds, forfeits,
releases, takedowns, appeals, vetoes and curator clearances, and a test fails if any of those is never reached). To
check the tests themselves, 42 deliberate one-line bugs were put into the contract one at a time (first price instead of
second price, a tie going to the later bid, forfeits or takedown proceeds sent to the wrong address, an off-by-one at
each phase boundary, an appeal that can clear, validators that accept a milder leader or a made-up reason, and so on).
The suite caught every one; the first run missed one (forfeits after the curator changes the beneficiary), and a test
for it was added.

## Deployed instance (Studionet)

| | |
|---|---|
| Contract | `0xAbca00A029bdEaF706ed136DAE54bc107A68ac9d` |
| Network | GenLayer Studionet |
| Deployment transaction | `0x66236d9ed47953126f73e8ae3bb533f49fdf01b130accf1828ea658adc8b268b` |
| Explorer | https://explorer-studio.genlayer.com/address/0xAbca00A029bdEaF706ed136DAE54bc107A68ac9d |

The same details are in `deployment.json` and `.env.example` (`PLINTH_ADDRESS`). To play a round against this instance
instead of deploying a new one: `npm run live:deployed`, or `node e2e/live.mjs --quick --address 0xAbca00A029bdEaF706ed136DAE54bc107A68ac9d`.
The report of the run that deployed it is `reports/live-report.md`: 67 checks passed, 0 failed, 1 warning; the books
(`solvency()`) were balanced at the end and the account balances moved exactly as the rules predict. In that run one
call returned an RPC error page (the node answered with HTML instead of JSON) and the bid still ended up read and cleared.

## Deploy on Studionet

Either paste `contracts/plinth.py` into [GenLayer Studio](https://studio.genlayer.com), choose Studionet, and deploy
without constructor arguments, or from this folder:

```bash
npm install
npm run keys        # creates .env with a funded Studionet test account (or copy .env.example and fill DEPLOY_KEY)
set -a; . ./.env; set +a
npm run deploy      # prints the contract address and writes it to .plinth-address
```

### A first round by hand (Studio, numbers in wei)

1. `create_slot("Builders corner", "Be about developer tools or open source|Make no promise of returns or guaranteed profit|Do not imitate another brand or person", 100000000000000000, 10000000000000000, 86400, 3600, 1800, 1800, 2000, "")`
   (0.1 GEN highest bid, 0.01 GEN reserve, one day on display, one hour to bid, half an hour to review, half an hour to
   reveal, 20% forfeit).
2. Compute a commitment with `node scripts/commit.mjs 0 <your address> 50000000000000000` and keep the salt.
3. `bid(0, "Ship faster with the Forge CLI, an open source build tool.", "", "<commitment>")` with value
   `100000000000000000`.
4. When the bid phase is over: `screen(<bid id>)` from any account. Read the result with `get_bid`.
5. In the reveal phase: `reveal(<bid id>, 50000000000000000, "<salt>")`.
6. When the reveal phase is over: `settle(0)`, then `current(0)` shows the winner. `release(<round id>)` pays the
   beneficiary when the display is over.

Use `status(0)` at any time to see which phase the slot is in and when it ends.

## Project layout

```
contracts/plinth.py       the intelligent contract
tests/direct/             the direct-mode suite
scripts/deploy.mjs        deploy to Studionet     scripts/receipt.mjs   read a transaction result
scripts/commit.mjs        compute a commitment    scripts/keys.mjs      make and fund a test account
scripts/setup.sh          install dependencies
```

## Live run on Studionet

`e2e/live.mjs` plays whole rounds on a fresh deployment with fresh funded accounts, checks every result against an
independent model of the rules (second price, refunds, forfeits, escrow, takedown refund) and writes
`reports/live-report.md` and `reports/live-report.json`.

```bash
npm install
npm run live:quick   # 1 slot, 4 bidders: refusal, tripwire, appeal, second price, refunds, release (about 12-15 minutes)
npm run live         # quick plus a second slot at the same time: veto, forfeit, reserve price, takedown (about 20 minutes)
npm run live:sim     # the quick run against an in-memory simulation (seconds): tests the script, NOT the contract
```

Options: `--address 0x...` (use a deployed contract instead of deploying a new one), `--bid-secs`, `--review-secs`,
`--reveal-secs`, `--hold-secs` (at least 60 each). Hard checks decide the verdict (exit code 1 on FAIL). The AI gate is a
live model, so its answers (and the account balances, which move when emitted transfers are processed) are warnings:
the report lists what the gate said for every message. If the gate is unsure about, or refuses, a compliant message,
the script uses the appeal and curator paths and records it. Run it from a Codespace; Studionet is not reachable from every sandbox.
