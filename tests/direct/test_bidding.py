"""Placing bids: validation, how a round opens, the one-bid rule, the full round, the waiting time between rounds."""

import json

import pytest

from conftest import *


@pytest.fixture
def c(direct_vm, direct_deploy):
    return deploy(direct_deploy, direct_vm)


@pytest.fixture
def vm(direct_vm):
    return direct_vm


@pytest.fixture
def sid(c, vm):
    return make_slot(c, vm, beneficiary=P.payee)


def good_commit(c, sid, who=P.alice, amount=40 * MILLI):
    return commit_for(c, sid, who, amount, salt_for(who))


def test_the_first_bid_opens_a_round_with_its_schedule(c, vm, sid):
    at(vm, 100)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI, link=LINK)
    assert bid_id == 0
    r = round_row(c, 0)
    assert (r["slot"], r["index"], r["stage"], r["phase"]) == (sid, 0, OPEN, "BID")
    assert r["opened"] == T0 + 100 and r["bid_end"] == T0 + 100 + BID_S
    assert r["review_end"] == r["bid_end"] + REVIEW_S and r["reveal_end"] == r["review_end"] + REVEAL_S
    assert (r["bids"], r["winner"], r["price"], r["escrow"]) == (1, -1, "0", "0") and r["beneficiary"] == hx(P.payee)
    b = bid_row(c, 0)
    assert (b["slot"], b["round"], b["bidder"]) == (sid, 0, hx(P.alice)) and b["creative"] == AD and b["link"] == LINK
    assert b["commit"] == good_commit(c, sid) and b["deposit"] == str(MAX_BID)
    assert (b["gate"], b["by"], b["tries"], b["review"], b["revealed"], b["outcome"]) == (PENDING, BY_NONE, 0, None, False, OUT_NONE)
    assert b["amount"] == "0"  # the price is not in the row before the reveal, whatever the bidder committed to
    assert books(c)["deposits_held"] == str(MAX_BID) and books(c)["balanced"]
    assert slot_row(c, sid)["rounds"] == 1


def test_later_bids_join_the_same_round_until_the_bid_phase_ends(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    at(vm, BID_S - 1)
    place(c, vm, sid, P.bob, 30 * MILLI)
    assert stats(c)["rounds"] == 1 and round_row(c, 0)["bids"] == 2
    assert [x["id"] for x in json.loads(c.bids_of_round(0, 0, 10))] == [0, 1]


def test_the_bid_phase_ends_exactly_at_bid_end(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    at(vm, BID_S)
    refuse(c, vm, "Bidding for this round is closed", c.bid, sid, AD2, "", good_commit(c, sid, P.bob), who=P.bob, value=MAX_BID)


BAD = [
    ("too little", dict(deposit=MAX_BID - 1), "exactly the slot's deposit"),
    ("too much", dict(deposit=MAX_BID + 1), "exactly the slot's deposit"),
    ("nothing", dict(deposit=0), "exactly the slot's deposit"),
    ("message too short", dict(creative="short"), "8 to 280"),
    ("message blank", dict(creative="         "), "8 to 280"),
    ("message too long", dict(creative="x" * 281), "8 to 280"),
    ("link not public", dict(link="https://127.0.0.1/x"), "public http(s)"),
    ("link with credentials", dict(link="https://u:p@forge.example.org/"), "public http(s)"),
    ("two links", dict(link="https://a.example.org/x https://b.example.org/y"), "public http(s)"),
    ("link too long", dict(link="https://forge.example.org/" + "a" * 200), "public http(s)"),
    ("commitment too short", dict(commit="ab" * 31), "64 hex"),
    ("commitment too long", dict(commit="ab" * 33), "64 hex"),
    ("commitment not hex", dict(commit="zz" * 32), "64 hex"),
    ("commitment empty", dict(commit=""), "64 hex"),
    ("commitment with 0x", dict(commit="0x" + "ab" * 31), "64 hex"),
]


@pytest.mark.parametrize("label,kw,msg", BAD, ids=[x[0] for x in BAD])
def test_a_bad_bid_is_refused_and_changes_nothing(c, vm, sid, label, kw, msg):
    at(vm, 0)
    place(c, vm, sid, P.bob, 20 * MILLI)  # a round exists, so that "nothing changes" covers a running round too
    commit = kw.get("commit", good_commit(c, sid))
    refuse(c, vm, msg, c.bid, sid, kw.get("creative", AD), kw.get("link", ""), commit, who=P.alice, value=kw.get("deposit", MAX_BID))


def test_a_bad_bid_does_not_open_a_round(c, vm, sid):
    at(vm, 0)
    refuse(c, vm, "8 to 280", c.bid, sid, "short", "", good_commit(c, sid), who=P.alice, value=MAX_BID)
    assert stats(c)["rounds"] == 0 and slot_row(c, sid)["rounds"] == 0 and stats(c)["bids"] == 0


def test_the_message_is_cleaned_and_the_commitment_lower_cased(c, vm, sid):
    at(vm, 0)
    commit = good_commit(c, sid).upper()
    act(vm, P.alice, MAX_BID)
    bid_id = c.bid(sid, "  Ship   <b>faster</b>   today  ", "  " + LINK + "  ", "  " + commit + "  ")
    row = bid_row(c, bid_id)
    assert row["creative"] == "Ship (b)faster(/b) today" and row["link"] == LINK and row["commit"] == commit.lower()


def test_no_link_is_stored_as_none(c, vm, sid):
    place(c, vm, sid, P.alice, 40 * MILLI)
    assert bid_row(c, 0)["link"] is None


def test_the_curator_and_the_beneficiary_cannot_bid(c, vm, sid):
    at(vm, 0)
    for who in (P.curator, P.payee):
        refuse(c, vm, "cannot bid", c.bid, sid, AD, "", good_commit(c, sid, who), who=who, value=MAX_BID)
    place(c, vm, sid, P.alice, 40 * MILLI)  # a running round: still refused
    for who in (P.curator, P.payee):
        refuse(c, vm, "cannot bid", c.bid, sid, AD, "", good_commit(c, sid, who), who=who, value=MAX_BID)


def test_one_bid_per_address_and_round(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    refuse(c, vm, "already have a bid", c.bid, sid, AD2, "", good_commit(c, sid, P.alice, 10 * MILLI), who=P.alice, value=MAX_BID)
    assert stats(c)["bids"] == 1


def test_a_round_takes_at_most_sixteen_bids(c, vm, sid):
    at(vm, 0)
    for i in range(16):
        place(c, vm, sid, P.extra[i], 20 * MILLI)
    assert round_row(c, 0)["bids"] == 16
    assert status(c, sid)["can_bid"] is False
    refuse(c, vm, "most bids it can take", c.bid, sid, AD, "", good_commit(c, sid, P.alice), who=P.alice, value=MAX_BID)


def test_bids_to_an_unknown_slot_are_refused(c, vm, sid):
    refuse(c, vm, "No such slot", c.bid, 9, AD, "", good_commit(c, sid), who=P.alice, value=MAX_BID)
    refuse(c, vm, "No such slot", c.bid, -1, AD, "", good_commit(c, sid), who=P.alice, value=MAX_BID)


def test_slots_are_independent(c, vm, sid):
    other = make_slot(c, vm, who=P.alice)
    at(vm, 0)
    place(c, vm, sid, P.bob, 40 * MILLI)
    place(c, vm, other, P.bob, 40 * MILLI)  # the same bidder may bid on two slots
    assert round_row(c, 0)["slot"] == sid and round_row(c, 1)["slot"] == other
    assert status(c, sid)["round"] == 0 and status(c, other)["round"] == 1


def test_bids_of_lists_a_bidders_bids_newest_first(c, vm, sid):
    other = make_slot(c, vm, who=P.alice)
    at(vm, 0)
    place(c, vm, sid, P.bob, 40 * MILLI)
    place(c, vm, other, P.bob, 40 * MILLI)
    place(c, vm, sid, P.carol, 40 * MILLI)
    assert [x["id"] for x in json.loads(c.bids_of(hx(P.bob), 0, 10))] == [1, 0]
    assert [x["id"] for x in json.loads(c.bids_of(hx(P.carol), 0, 10))] == [2]
    assert json.loads(c.bids_of(hx(P.stranger), 0, 10)) == []
    assert [x["id"] for x in json.loads(c.bids_of(hx(P.bob), 1, 10))] == [0]


def test_bids_of_round_pages_in_placement_order(c, vm, sid):
    at(vm, 0)
    for i in range(5):
        place(c, vm, sid, P.extra[i], 20 * MILLI)
    assert [x["id"] for x in json.loads(c.bids_of_round(0, 0, 2))] == [0, 1]
    assert [x["id"] for x in json.loads(c.bids_of_round(0, 2, 2))] == [2, 3]
    assert [x["id"] for x in json.loads(c.bids_of_round(0, 4, 9))] == [4]
    assert json.loads(c.bids_of_round(0, 5, 9)) == [] and json.loads(c.bids_of_round(0, 0, 0)) == []
    refuse(c, vm, "No such round", c.bids_of_round, 3, 0, 5)


# ---- the next round -------------------------------------------------------------------------------------------------


def settled_slot(c, vm, sid, start=0, amounts=(40 * MILLI, 25 * MILLI)):
    run_round(c, vm, sid, [P.alice, P.bob][: len(amounts)], list(amounts), start=start)


def test_no_new_round_while_the_old_one_is_unsettled(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    at(vm, TOTAL + 50)  # the round is over but nobody settled it
    refuse(c, vm, "closed", c.bid, sid, AD, "", good_commit(c, sid, P.bob), who=P.bob, value=MAX_BID)
    assert status(c, sid)["phase"] == "SETTLE" and status(c, sid)["can_bid"] is False


def test_a_new_round_waits_until_the_display_is_close_to_its_end(c, vm, sid):
    settled_slot(c, vm, sid)
    shown_until = TOTAL + 1 + HOLD  # the helper settles one second after the reveal phase
    opens = shown_until - TOTAL  # the new round may open so that it can settle exactly when the display ends
    st = status(c, sid)
    assert st["phase"] == "IDLE" and st["opens_at"] == T0 + opens and st["can_bid"] is False
    at(vm, opens - 1)
    assert status(c, sid)["can_bid"] is False and status(c, sid)["opens_at"] == T0 + opens
    refuse(c, vm, "winner is on display", c.bid, sid, AD, "", good_commit(c, sid, P.carol), who=P.carol, value=MAX_BID)
    at(vm, opens)
    assert status(c, sid)["can_bid"] is True and status(c, sid)["opens_at"] == 0
    bid_id = place(c, vm, sid, P.carol, 40 * MILLI)
    r = round_row(c, 1)
    assert r["index"] == 1 and r["reveal_end"] == T0 + shown_until  # the next winner appears exactly when the old one leaves
    assert bid_row(c, bid_id)["round"] == 1


def test_the_old_winner_stays_on_display_while_the_next_round_runs(c, vm, sid):
    settled_slot(c, vm, sid)
    at(vm, HOLD + 10)
    place(c, vm, sid, P.carol, 40 * MILLI)
    assert current(c, sid)["occupied"] is True and current(c, sid)["bidder"].lower() == hx(P.alice)


def test_a_void_round_lets_the_next_one_open_at_once(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)  # never cleared, never revealed
    settle(c, vm, sid, offset=TOTAL + 1)
    assert round_row(c, 0)["stage"] == VOID
    st = status(c, sid)
    assert st["phase"] == "IDLE" and st["opens_at"] == 0 and st["can_bid"] is True
    place(c, vm, sid, P.alice, 40 * MILLI)  # the same address may bid again: it is a new round
    assert stats(c)["rounds"] == 2 and slot_row(c, sid)["rounds"] == 2


def test_the_same_address_may_bid_in_every_round(c, vm, sid):
    for i in range(3):
        at(vm, i * (TOTAL + 10))
        place(c, vm, sid, P.alice, 40 * MILLI, salt=f"fresh-salt-{i}")
        settle(c, vm, sid, offset=i * (TOTAL + 10) + TOTAL + 1)
    assert stats(c)["rounds"] == 3 and stats(c)["void"] == 3


def test_after_a_takedown_the_next_round_can_open_at_once(c, vm, sid):
    settled_slot(c, vm, sid)
    at(vm, TOTAL + 100)
    act(vm, P.curator)
    c.takedown(0, "The message turned out to be misleading.")
    assert status(c, sid)["opens_at"] == 0 and status(c, sid)["can_bid"] is True
    place(c, vm, sid, P.carol, 40 * MILLI)
    assert round_row(c, 1)["index"] == 1


def test_the_opening_time_is_reported_before_any_bid(c, vm, sid):
    st = status(c, sid)
    assert (st["phase"], st["round"], st["opens_at"], st["can_bid"]) == ("IDLE", -1, 0, True)


def test_status_follows_the_phases_of_a_round(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    expect = [(0, "BID", T0 + BID_S), (BID_S - 1, "BID", T0 + BID_S), (BID_S, "REVIEW", T0 + BID_S + REVIEW_S),
              (BID_S + REVIEW_S - 1, "REVIEW", T0 + BID_S + REVIEW_S), (BID_S + REVIEW_S, "REVEAL", T0 + TOTAL),
              (TOTAL - 1, "REVEAL", T0 + TOTAL), (TOTAL, "SETTLE", 0)]
    for offset, phase, ends in expect:
        at(vm, offset)
        st = status(c, sid)
        assert (st["phase"], st["ends_at"]) == (phase, ends), offset
        assert round_row(c, 0)["phase"] == phase
