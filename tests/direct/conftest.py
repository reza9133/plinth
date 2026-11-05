"""Shared helpers for the direct-mode suite (genlayer-test fixtures)."""

import json
import sys
from datetime import datetime, timezone

import pytest

CONTRACT = "contracts/plinth.py"
MODULE = "_contract_plinth"
GEN = 10**18
MILLI = 10**15  # 0.001 GEN, the smallest price

# bid gate, round stage, bid outcome (the numbers the contract reports)
PENDING, CLEARED, UNSURE, REFUSED, VETOED = range(5)
BY_NONE, BY_AI, BY_CURATOR = range(3)
OPEN, SETTLED, VOID, RELEASED, TAKEN_DOWN = range(5)
OUT_NONE, OUT_WON, OUT_LOST, OUT_EXCLUDED, OUT_FORFEITED = range(5)
MET, DOUBT, VIOLATED = 0, 1, 2

T0 = int(datetime(2026, 10, 20, 12, 0, 0, tzinfo=timezone.utc).timestamp())

# default slot shape used by most tests
MAX_BID = 100 * MILLI  # 0.1 GEN
RESERVE = 10 * MILLI
HOLD = 3600
BID_S, REVIEW_S, REVEAL_S = 600, 600, 600
FORFEIT = 2000  # 20%
TOTAL = BID_S + REVIEW_S + REVEAL_S
RULES = "Be about developer tools or open source|Make no promise of returns or guaranteed profit|Do not imitate another brand or person"
NAME = "Builders corner"
AD = "Ship faster with the Forge CLI, an open source build tool."
AD2 = "Weekly newsletter about compilers and type systems."
LINK = "https://forge.example.org/start"


def hx(a) -> str:
    """Lower-case 0x form of an address object, raw bytes or a hex string."""
    if isinstance(a, str):
        return a.lower()
    if hasattr(a, "as_hex"):
        return str(a.as_hex).lower()
    return "0x" + bytes(a).hex()


def at(vm, offset: int) -> None:
    """Move the chain clock to T0 + offset seconds."""
    vm.warp(datetime.fromtimestamp(T0 + offset, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))


def act(vm, who, value: int = 0):
    """The next call is made by `who` and carries `value`."""
    try:
        vm.deal(who, 1000 * GEN)
    except Exception:
        pass
    vm.sender = who
    vm.value = value


class Wire:
    """Stands in for the chain-level transfer so that payouts can be inspected."""

    sent = []

    def __init__(self, who):
        self.who = who

    def emit_transfer(self, **kw):
        Wire.sent.append((hx(self.who), int(kw["value"])))


class Ledger:
    def __init__(self):
        Wire.sent = []

    @property
    def sent(self):
        return Wire.sent

    def to(self, who) -> int:
        key = hx(who)
        return sum(v for a, v in Wire.sent if a == key)

    def total(self) -> int:
        return sum(v for _, v in Wire.sent)

    def count(self) -> int:
        return len(Wire.sent)


@pytest.fixture
def ledger():
    return Ledger()


def _forget_contract_class() -> None:
    """The SDK keeps one contract class per process; drop it so every test can deploy afresh."""
    for name in ("genlayer.gl.genvm_contracts", "genlayer.genvm_contracts"):
        registry = sys.modules.get(name)
        if registry is not None and hasattr(registry, "__known_contract__"):
            registry.__known_contract__ = None


def deploy(direct_deploy, direct_vm):
    at(direct_vm, 0)
    direct_vm.check_pickling = True  # the closures handed to the VM must be serializable
    _forget_contract_class()
    c = direct_deploy(CONTRACT)
    mod = sys.modules[MODULE]
    mod._Wire = Wire
    Wire.sent = []
    return c


def _actor(n: int) -> bytes:
    return bytes([0xC0, n]) + bytes(18)


class P:
    """Fixed actors, as raw 20-byte addresses."""

    curator = _actor(1)
    payee = _actor(2)
    alice = _actor(3)
    bob = _actor(4)
    carol = _actor(5)
    dave = _actor(6)
    stranger = _actor(7)
    extra = [_actor(20 + i) for i in range(40)]


ZERO_ADDRESS = "0x" + "0" * 40


def stats(c) -> dict:
    return json.loads(c.stats())


def books(c) -> dict:
    return json.loads(c.solvency())


def slot_row(c, slot_id: int) -> dict:
    return _lowered(json.loads(c.get_slot(slot_id)))


def round_row(c, round_id: int) -> dict:
    return _lowered(json.loads(c.get_round(round_id)))


def bid_row(c, bid_id: int) -> dict:
    return _lowered(json.loads(c.get_bid(bid_id)))


def _lowered(row):
    """The contract reports checksummed addresses; the tests compare lower-case ones."""
    if isinstance(row, dict):
        for k, v in row.items():
            if k in ("curator", "beneficiary", "bidder") and isinstance(v, str):
                row[k] = v.lower()
    return row


def status(c, slot_id: int) -> dict:
    return json.loads(c.status(slot_id))


def current(c, slot_id: int) -> dict:
    return json.loads(c.current(slot_id))


def make_slot(
    c, vm, who=None, name=NAME, rules=RULES, max_bid=MAX_BID, reserve=RESERVE, hold=HOLD, bid_s=BID_S,
    review_s=REVIEW_S, reveal_s=REVEAL_S, forfeit=FORFEIT, beneficiary=None,
) -> int:
    act(vm, who if who is not None else P.curator)
    return c.create_slot(
        name, rules, max_bid, reserve, hold, bid_s, review_s, reveal_s, forfeit,
        hx(beneficiary) if beneficiary is not None else "",
    )


def salt_for(who, n: int = 0) -> str:
    return f"salt-{hx(who)[2:10]}-{n}"


def commit_for(c, slot_id: int, who, amount: int, salt: str) -> str:
    return c.commitment_for(slot_id, hx(who), amount, salt)


def place(c, vm, slot_id: int, who, amount: int, creative=AD, link="", salt=None, deposit=None) -> int:
    """Commit to `amount` and place the bid. Returns the bid id; the salt used is salt_for(who) unless given."""
    salt = salt if salt is not None else salt_for(who)
    commitment = commit_for(c, slot_id, who, amount, salt)
    dep = deposit if deposit is not None else int(slot_row(c, slot_id)["max_bid"])
    act(vm, who, dep)
    bid_id = c.bid(slot_id, creative, link, commitment)
    vm.value = 0
    return bid_id


def gate_reply(marks=(0, 0, 0), reason="The message fits the rules.", raw=None):
    return raw if raw is not None else json.dumps({"marks": list(marks), "reason": reason})


def mock_gate(vm, marks=(0, 0, 0), reason="The message fits the rules.", raw=None):
    """The strict gate's answer (matches the first-read prompt only)."""
    vm.mock_llm(r"content gate", gate_reply(marks, reason, raw))


def mock_appeals(vm, marks=(0, 0, 0), reason="A reasonable reading complies.", raw=None):
    vm.mock_llm(r"appeals reader", gate_reply(marks, reason, raw))


def screen(c, vm, caller, bid_id, marks=(0, 0, 0), offset=None, raw=None, reason="The message fits the rules."):
    vm.clear_mocks()
    mock_gate(vm, marks, reason, raw)
    if offset is not None:
        at(vm, offset)
    act(vm, caller)
    c.screen(bid_id)


def appeal(c, vm, bidder, bid_id, note="The message is about developer tools and promises nothing.", marks=(0, 0, 0), offset=None, raw=None):
    vm.clear_mocks()
    mock_appeals(vm, marks, raw=raw)
    if offset is not None:
        at(vm, offset)
    act(vm, bidder)
    c.appeal(bid_id, note)


def reveal(c, vm, who, bid_id, amount, salt=None, offset=None):
    if offset is not None:
        at(vm, offset)
    act(vm, who)
    c.reveal(bid_id, amount, salt if salt is not None else salt_for(who))


def settle(c, vm, slot_id, caller=None, offset=None):
    if offset is not None:
        at(vm, offset)
    act(vm, caller if caller is not None else P.stranger)
    c.settle(slot_id)


def fingerprint(c) -> str:
    """Everything observable about the contract, so that a refused call can be shown to change nothing."""
    s = stats(c)
    return json.dumps(
        [
            s, books(c), [slot_row(c, i) for i in range(s["slots"])], [round_row(c, i) for i in range(s["rounds"])],
            [bid_row(c, i) for i in range(s["bids"])], list(Wire.sent),
        ],
        sort_keys=True,
    )


def refuse(c, vm, msg, fn, *args, who=None, value=0):
    """The call must be refused with `msg` in the error, and it must leave the contract exactly as it was."""
    if who is not None:
        act(vm, who, value)
    before = fingerprint(c)
    with vm.expect_revert(msg):
        fn(*args)
    vm.value = 0
    assert fingerprint(c) == before, "a refused call changed the contract"


def run_round(c, vm, slot_id, bidders, amounts, marks=None, start=0):
    """A whole round: everybody bids at `start`, the gate clears everyone, all reveal, the round settles.

    Returns the list of bid ids. The clock ends at the settle time."""
    at(vm, start)
    ids = []
    for who, amount in zip(bidders, amounts):
        ids.append(place(c, vm, slot_id, who, amount))
    for bid_id, who in zip(ids, bidders):
        screen(c, vm, P.stranger, bid_id, marks=(marks or (0, 0, 0)), offset=start + BID_S + 5)
    for bid_id, who, amount in zip(ids, bidders, amounts):
        reveal(c, vm, who, bid_id, amount, offset=start + BID_S + REVIEW_S + 5)
    settle(c, vm, slot_id, offset=start + TOTAL + 1)
    return ids
