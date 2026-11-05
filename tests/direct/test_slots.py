"""Opening and configuring slots: validation, views, paging, pausing, the beneficiary."""

import json

import pytest

from conftest import *


@pytest.fixture
def c(direct_vm, direct_deploy):
    return deploy(direct_deploy, direct_vm)


@pytest.fixture
def vm(direct_vm):
    return direct_vm


def test_a_slot_is_stored_as_given(c, vm):
    at(vm, 50)
    sid = make_slot(c, vm, beneficiary=P.payee)
    row = slot_row(c, sid)
    assert sid == 0
    assert row["curator"] == hx(P.curator) and row["beneficiary"] == hx(P.payee) and row["name"] == NAME
    assert row["rules"] == RULES.split("|") and row["created"] == T0 + 50 and row["paused"] is False
    assert (row["max_bid"], row["reserve"], row["hold"]) == (str(MAX_BID), str(RESERVE), HOLD)
    assert (row["bid_secs"], row["review_secs"], row["reveal_secs"], row["forfeit_bps"]) == (BID_S, REVIEW_S, REVEAL_S, FORFEIT)
    assert (row["rounds"], row["showing"]) == (0, -1)
    assert stats(c)["slots"] == 1


def test_the_beneficiary_defaults_to_the_curator(c, vm):
    sid = make_slot(c, vm)
    assert slot_row(c, sid)["beneficiary"] == hx(P.curator)


def test_text_is_cleaned(c, vm):
    sid = make_slot(c, vm, name="  My   <big>  slot ", rules=" A rule  with   space | Another   <b>rule</b> here ")
    row = slot_row(c, sid)
    assert row["name"] == "My (big) slot" and row["rules"] == ["A rule with space", "Another (b)rule(/b) here"]


def test_slot_ids_count_up_and_belong_to_their_curator(c, vm):
    a = make_slot(c, vm, who=P.curator)
    b = make_slot(c, vm, who=P.alice)
    d = make_slot(c, vm, who=P.curator)
    assert (a, b, d) == (0, 1, 2)
    mine = json.loads(c.slots_of(hx(P.curator), 0, 10))
    assert [x["id"] for x in mine] == [2, 0]
    assert [x["id"] for x in json.loads(c.slots_of(hx(P.alice), 0, 10))] == [1]
    assert json.loads(c.slots_of(hx(P.stranger), 0, 10)) == []


def test_listing_is_newest_first_and_paged(c, vm):
    for _ in range(7):
        make_slot(c, vm)
    assert [x["id"] for x in json.loads(c.list_slots(0, 3))] == [6, 5, 4]
    assert [x["id"] for x in json.loads(c.list_slots(3, 3))] == [3, 2, 1]
    assert [x["id"] for x in json.loads(c.list_slots(6, 10))] == [0]
    assert json.loads(c.list_slots(7, 10)) == []
    assert json.loads(c.list_slots(0, 0)) == []
    assert json.loads(c.list_slots(0, -4)) == []
    assert [x["id"] for x in json.loads(c.list_slots(-5, 2))] == [6, 5]  # a negative offset counts as zero
    assert len(json.loads(c.list_slots(0, 10_000))) == 7  # the page size is clamped, not the data


def test_the_page_size_is_limited_to_fifty(c, vm):
    for _ in range(55):
        make_slot(c, vm)
    assert len(json.loads(c.list_slots(0, 1000))) == 50
    assert len(json.loads(c.slots_of(hx(P.curator), 0, 1000))) == 50


BAD = [
    ("name too short", dict(name="ab"), "name needs"),
    ("name blank", dict(name="    "), "name needs"),
    ("name too long", dict(name="x" * 61), "name needs"),
    ("no rules", dict(rules=""), "1 to 5 rules"),
    ("only separators", dict(rules=" | | "), "1 to 5 rules"),
    ("six rules", dict(rules="|".join(f"a long enough rule {i}" for i in range(6))), "1 to 5 rules"),
    ("rule too short", dict(rules="short"), "8 to 140"),
    ("rule too long", dict(rules="x" * 141), "8 to 140"),
    ("same rule twice", dict(rules="Stay on topic please|stay   ON topic please"), "same"),
    ("max bid below the minimum", dict(max_bid=MILLI - 1, reserve=MILLI - 1), "highest bid"),
    ("max bid zero", dict(max_bid=0, reserve=0), "highest bid"),
    ("max bid negative", dict(max_bid=-1), "highest bid"),
    ("max bid above the ceiling", dict(max_bid=10**24 + 1), "highest bid"),
    ("reserve below the minimum", dict(reserve=MILLI - 1), "reserve"),
    ("reserve zero", dict(reserve=0), "reserve"),
    ("reserve negative", dict(reserve=-5), "reserve"),
    ("reserve above the max bid", dict(reserve=MAX_BID + 1), "reserve"),
    ("hold too short", dict(hold=59), "display time"),
    ("hold too long", dict(hold=30 * 86400 + 1), "display time"),
    ("bid phase too short", dict(bid_s=59), "phase"),
    ("review phase too short", dict(review_s=59), "phase"),
    ("reveal phase too short", dict(reveal_s=59), "phase"),
    ("bid phase too long", dict(bid_s=14 * 86400 + 1), "phase"),
    ("review phase negative", dict(review_s=-1), "phase"),
    ("reveal phase too long", dict(reveal_s=14 * 86400 + 1), "phase"),
    ("forfeit below 5%", dict(forfeit=499), "forfeit"),
    ("forfeit above 50%", dict(forfeit=5001), "forfeit"),
    ("forfeit negative", dict(forfeit=-1), "forfeit"),
    ("beneficiary is garbage", dict(beneficiary="nobody"), "not a valid address"),
    ("beneficiary is zero", dict(beneficiary=ZERO_ADDRESS), "cannot be the beneficiary"),
]


@pytest.mark.parametrize("label,kw,msg", BAD, ids=[x[0] for x in BAD])
def test_a_bad_slot_is_refused_and_changes_nothing(c, vm, label, kw, msg):
    make_slot(c, vm)  # something already there, so that "changes nothing" means something
    args = dict(name=NAME, rules=RULES, max_bid=MAX_BID, reserve=RESERVE, hold=HOLD, bid_s=BID_S, review_s=REVIEW_S,
                reveal_s=REVEAL_S, forfeit=FORFEIT, beneficiary="")
    args.update(kw)
    ben = args["beneficiary"]
    ben = hx(ben) if isinstance(ben, (bytes, bytearray)) else ben
    refuse(c, vm, msg, c.create_slot, args["name"], args["rules"], args["max_bid"], args["reserve"], args["hold"],
           args["bid_s"], args["review_s"], args["reveal_s"], args["forfeit"], ben, who=P.curator)


def test_the_limits_themselves_are_allowed(c, vm):
    make_slot(c, vm, max_bid=MILLI, reserve=MILLI, hold=60, bid_s=60, review_s=60, reveal_s=60, forfeit=500)
    make_slot(c, vm, max_bid=10**24, reserve=10**24, hold=30 * 86400, bid_s=14 * 86400, review_s=14 * 86400, reveal_s=14 * 86400, forfeit=5000)
    make_slot(c, vm, rules="|".join(f"a long enough rule {i}" for i in range(5)))
    make_slot(c, vm, name="abc")
    make_slot(c, vm, name="x" * 60)
    assert stats(c)["slots"] == 5


def test_the_contract_itself_cannot_be_the_beneficiary(c, vm):
    import sys
    mod = sys.modules[MODULE]
    act(vm, P.curator)
    own = None
    try:
        own = c.address
    except Exception:
        pass
    if own is None:
        pytest.skip("the direct runner does not expose the contract address")
    with vm.expect_revert("cannot be the beneficiary"):
        c.create_slot(NAME, RULES, MAX_BID, RESERVE, HOLD, BID_S, REVIEW_S, REVEAL_S, FORFEIT, hx(own))


def test_unknown_slots_are_refused(c, vm):
    for call in (lambda: c.get_slot(0), lambda: c.status(0), lambda: c.current(0), lambda: c.rounds_of(0, 0, 5),
                 lambda: c.get_slot(-1), lambda: c.set_paused(3, True), lambda: c.settle(0)):
        act(vm, P.curator)
        with vm.expect_revert("No such slot"):
            call()


# ---- pausing and the beneficiary ------------------------------------------------------------------------------------


def test_only_the_curator_pauses_and_resumes(c, vm):
    sid = make_slot(c, vm)
    for who in (P.alice, P.stranger, P.payee):
        refuse(c, vm, "Only the curator", c.set_paused, sid, True, who=who)
    act(vm, P.curator)
    c.set_paused(sid, True)
    assert slot_row(c, sid)["paused"] is True and status(c, sid)["paused"] is True
    refuse(c, vm, "Only the curator", c.set_paused, sid, False, who=P.alice)
    act(vm, P.curator)
    c.set_paused(sid, False)
    assert slot_row(c, sid)["paused"] is False


def test_a_paused_slot_takes_no_new_bids_but_finishes_its_round(c, vm, ledger):
    sid = make_slot(c, vm)
    at(vm, 0)
    b1 = place(c, vm, sid, P.alice, 40 * MILLI)
    act(vm, P.curator)
    c.set_paused(sid, True)
    commitment = commit_for(c, sid, P.bob, 20 * MILLI, salt_for(P.bob))
    refuse(c, vm, "paused", c.bid, sid, AD2, "", commitment, who=P.bob, value=MAX_BID)
    assert status(c, sid)["can_bid"] is False
    screen(c, vm, P.stranger, b1, offset=BID_S + 5)
    reveal(c, vm, P.alice, b1, 40 * MILLI, offset=BID_S + REVIEW_S + 5)
    settle(c, vm, sid, offset=TOTAL + 1)
    assert round_row(c, 0)["stage"] == SETTLED and ledger.to(P.alice) == MAX_BID - RESERVE
    assert books(c)["balanced"]


def test_the_beneficiary_can_change_for_future_rounds_only(c, vm, ledger):
    sid = make_slot(c, vm, beneficiary=P.payee)
    at(vm, 0)
    b1 = place(c, vm, sid, P.alice, 40 * MILLI)
    act(vm, P.curator)
    c.set_beneficiary(sid, hx(P.carol))
    assert slot_row(c, sid)["beneficiary"] == hx(P.carol)
    assert round_row(c, 0)["beneficiary"] == hx(P.payee)  # the running round keeps its own
    screen(c, vm, P.stranger, b1, offset=BID_S + 5)
    reveal(c, vm, P.alice, b1, 40 * MILLI, offset=BID_S + REVIEW_S + 5)
    settle(c, vm, sid, offset=TOTAL + 1)
    act(vm, P.stranger)
    at(vm, TOTAL + HOLD + 5)
    c.release(0)
    assert ledger.to(P.payee) == RESERVE and ledger.to(P.carol) == 0
    # the next round pays the new one
    at(vm, TOTAL + HOLD + 10)
    b2 = place(c, vm, sid, P.bob, 40 * MILLI)
    assert round_row(c, 1)["beneficiary"] == hx(P.carol)
    # the old beneficiary is an ordinary address now, the new one is not allowed to bid
    commitment = commit_for(c, sid, P.carol, 20 * MILLI, salt_for(P.carol))
    refuse(c, vm, "cannot bid", c.bid, sid, AD2, "", commitment, who=P.carol, value=MAX_BID)


@pytest.mark.parametrize("who,msg", [("garbage", "not a valid address"), (ZERO_ADDRESS, "cannot be the beneficiary")])
def test_a_bad_new_beneficiary_is_refused(c, vm, who, msg):
    sid = make_slot(c, vm)
    refuse(c, vm, msg, c.set_beneficiary, sid, who, who=P.curator)


def test_only_the_curator_changes_the_beneficiary(c, vm):
    sid = make_slot(c, vm)
    refuse(c, vm, "Only the curator", c.set_beneficiary, sid, hx(P.alice), who=P.alice)
    act(vm, P.curator)
    c.set_beneficiary(sid, "")  # empty means the curator again
    assert slot_row(c, sid)["beneficiary"] == hx(P.curator)


def test_forfeits_and_takedown_pay_the_beneficiary_the_round_opened_with(c, vm, ledger):
    """The curator changes the beneficiary while a round runs: everything that round earns still goes to the old one."""
    sid = make_slot(c, vm, beneficiary=P.payee)
    at(vm, 0)
    a = place(c, vm, sid, P.alice, 50 * MILLI)
    b = place(c, vm, sid, P.bob, 90 * MILLI)
    act(vm, P.curator)
    c.set_beneficiary(sid, hx(P.carol))
    for bid_id in (a, b):
        screen(c, vm, P.stranger, bid_id, offset=BID_S + 5)
    reveal(c, vm, P.alice, a, 50 * MILLI, offset=BID_S + REVIEW_S + 5)  # bob never reveals: his forfeit is earned
    settle(c, vm, sid, offset=TOTAL + 1)
    fee = MAX_BID * FORFEIT // 10_000
    assert ledger.to(P.payee) == fee and ledger.to(P.carol) == 0
    at(vm, TOTAL + 1 + HOLD // 2)
    act(vm, P.curator)
    c.takedown(0, "Taking it down half way through.")
    price = RESERVE
    kept = price - price * (HOLD - HOLD // 2) // HOLD
    assert ledger.to(P.payee) == fee + kept and ledger.to(P.carol) == 0
    assert books(c)["balanced"]
