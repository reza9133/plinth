// Small helpers shared by the live run and the simulated run: money formatting, a report that collects checks,
// transactions and observations, and the writer that turns it into reports/live-report.md and .json.
import { mkdirSync, writeFileSync } from "node:fs";
import { formatEther } from "viem";

export const GEN = 10n ** 18n;
export const MILLI = 10n ** 15n; // 0.001 GEN
export const gen = (wei) => `${formatEther(BigInt(wei))} GEN`;
export const lc = (s) => String(s ?? "").toLowerCase();
export const short = (h) => (h ? `${String(h).slice(0, 10)}…${String(h).slice(-6)}` : "-");
export const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

export class Abort extends Error {}

export class Report {
  constructor(meta) {
    this.meta = meta;
    this.started = Date.now();
    this.checks = [];
    this.txs = [];
    this.observations = [];
    this.balances = [];
    this.notes = [];
    this.aborted = [];
  }

  stamp() {
    const s = Math.round((Date.now() - this.started) / 1000);
    return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
  }

  log(msg) {
    console.log(`${this.stamp()} ${msg}`);
  }

  // kind "hard": a failure makes the run FAIL. kind "soft": a failure is a warning (model behaviour, balances).
  check(scenario, id, title, pass, detail = "", kind = "hard") {
    const status = pass === null ? "SKIP" : pass ? "PASS" : kind === "hard" ? "FAIL" : "WARN";
    this.checks.push({ scenario, id, title, kind, status, detail: String(detail ?? "") });
    this.log(`${status.padEnd(4)} ${scenario}.${id}  ${title}${detail && status !== "PASS" ? `  (${detail})` : ""}`);
    return pass === true;
  }

  tx(t) {
    this.txs.push(t);
  }

  observe(scenario, what, data) {
    this.observations.push({ scenario, what, data });
  }

  note(msg) {
    this.notes.push(msg);
    this.log(`note: ${msg}`);
  }

  counts() {
    const c = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
    for (const k of this.checks) c[k.status]++;
    return c;
  }

  verdict() {
    const c = this.counts();
    if (c.FAIL > 0) return "FAIL";
    if (this.aborted.length > 0) return "INCONCLUSIVE";
    return "PASS";
  }

  toJSON() {
    return {
      meta: this.meta,
      verdict: this.verdict(),
      counts: this.counts(),
      seconds: Math.round((Date.now() - this.started) / 1000),
      checks: this.checks,
      observations: this.observations,
      balances: this.balances,
      transactions: this.txs,
      notes: this.notes,
      aborted: this.aborted,
    };
  }

  toMarkdown() {
    const c = this.counts();
    const m = this.meta;
    const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    const L = [];
    L.push(`# Plinth live run report`);
    L.push("");
    L.push(`**Verdict: ${this.verdict()}**  (${c.PASS} passed, ${c.FAIL} failed, ${c.WARN} warnings, ${c.SKIP} skipped)`);
    L.push("");
    L.push(`| | |`);
    L.push(`|---|---|`);
    L.push(`| Mode | ${m.mode} |`);
    L.push(`| Profile | ${m.profile} |`);
    L.push(`| Network | ${esc(m.rpc)} |`);
    L.push(`| Contract | \`${m.contract}\` |`);
    L.push(`| Started | ${m.startedAt} |`);
    L.push(`| Duration | ${Math.round((Date.now() - this.started) / 1000)} s |`);
    L.push(`| Phases (s) | bid ${m.phases.bid}, review ${m.phases.review}, reveal ${m.phases.reveal}, display ${m.phases.hold} |`);
    L.push(`| Transactions | ${this.txs.length} |`);
    L.push("");
    L.push(`Hard checks decide the verdict. Warnings are model behaviour or balance observations that depend on the network (the AI gate is a live model; balances move when emitted transfers are processed).`);
    L.push("");
    for (const sc of [...new Set(this.checks.map((k) => k.scenario))]) {
      L.push(`## Checks ${sc}`);
      L.push("");
      L.push(`| Status | Check | Kind | Detail |`);
      L.push(`|---|---|---|---|`);
      for (const k of this.checks.filter((x) => x.scenario === sc)) L.push(`| ${k.status} | ${k.id}: ${esc(k.title)} | ${k.kind} | ${esc(k.detail)} |`);
      L.push("");
    }
    if (this.aborted.length) {
      L.push(`## Aborted`);
      L.push("");
      for (const a of this.aborted) L.push(`- ${esc(a)}`);
      L.push("");
    }
    if (this.observations.length) {
      L.push(`## What the gate said`);
      L.push("");
      L.push(`| Scenario | Bid | Message | Gate | By | Marks | Reason |`);
      L.push(`|---|---|---|---|---|---|---|`);
      for (const o of this.observations.filter((x) => x.what === "gate")) {
        const d = o.data;
        L.push(`| ${o.scenario} | ${d.role} (#${d.bid}) | ${esc(d.message)} | ${d.gate} | ${d.by} | ${esc(JSON.stringify(d.marks))} | ${esc(d.reason)} |`);
      }
      L.push("");
      const other = this.observations.filter((x) => x.what !== "gate");
      if (other.length) {
        L.push(`## Other observations`);
        L.push("");
        for (const o of other) L.push(`- **${o.scenario} ${o.what}**: ${esc(JSON.stringify(o.data, bigintSafe))}`);
        L.push("");
      }
    }
    if (this.balances.length) {
      L.push(`## Balances (wei)`);
      L.push("");
      L.push(`| Scenario | Account | Before | After | Change | Expected | Match |`);
      L.push(`|---|---|---|---|---|---|---|`);
      for (const b of this.balances) L.push(`| ${b.scenario} | ${b.who} | ${b.before} | ${b.after} | ${b.delta} | ${b.expected} | ${b.match} |`);
      L.push("");
    }
    L.push(`## Transactions`);
    L.push("");
    L.push(`| # | Scenario | Sender | Call | Result | Seconds | Hash |`);
    L.push(`|---|---|---|---|---|---|---|`);
    this.txs.forEach((t, i) => L.push(`| ${i + 1} | ${t.scenario ?? "-"} | ${t.actor} | ${esc(t.label)} | ${esc(t.status)}${t.error ? ` — ${esc(String(t.error).slice(0, 120))}` : ""} | ${Math.round(t.ms / 1000)} | ${short(t.hash)} |`));
    L.push("");
    if (this.notes.length) {
      L.push(`## Notes`);
      L.push("");
      for (const n of this.notes) L.push(`- ${esc(n)}`);
      L.push("");
    }
    return L.join("\n");
  }

  write(dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("live-report.md", dir), this.toMarkdown());
    writeFileSync(new URL("live-report.json", dir), JSON.stringify(this.toJSON(), bigintSafe, 2));
  }
}
