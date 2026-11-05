"""Reveal, settle, release and takedown: who wins, who pays what, where every wei goes."""

import json

import pytest

from conftest import *

REVIEW_AT = BID_S + 5
REVEAL_AT = BID_S + REVIEW_S + 5
SETTLE_AT = TOTAL + 1


@pytest.fixture
def c(direct_vm, direct_deploy):
    return deploy(direct_deploy, direct_vm)


@pytest.fixture
def vm(direct_vm):
    return direct_vm


@pytest.fixture
def sid(c, vm):
    return make_slot(c, vm, beneficiary=P.payee)


def cleared_bids(c, vm, sid, pairs, start=0):
    """Place every bid at `start` (the bid phase), then let the gate clear them all inside the review phase."""
    at(vm, start)
    ids = [place(c, vm, sid, who, amount) for who, amount in pairs]
    for bid_id in ids:
        screen(c, vm, P.stranger, bid_id, offset=start + REVIEW_AT)
    return ids


def cleared_bid(c, vm, sid, who, amount, start=0):
    return cleared_bids(c, vm, sid, [(who, amount)], start=start)[0]


# ---- reveal ---------------------------------------------------------------------------------------------------------


@pytest.fixture
def one(c, vm, sid):
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI)
    screen(c, vm, P.stranger, bid_id, offset=REVIEW_AT)
    return bid_id


def test_a_cleared_bid_reveals_its_price(c, vm, one):
    reveal(c, vm, P.alice, one, 40 * MILLI, offset=REVEAL_AT)
    row = bid_row(c, one)
    assert row["revealed"] is True and row["amount"] == str(40 * MILLI)


def test_the_reveal_window_is_exact(c, vm, one):
    refuse(c, vm, "reveal phase", c.reveal, one, 40 * MILLI, salt_for(P.alice), who=P.alice)  # still the review phase
    at(vm, BID_S + REVIEW_S - 1)
    refuse(c, vm, "reveal phase", c.reveal, one, 40 * MILLI, salt_for(P.alice), who=P.alice)
    at(vm, TOTAL)
    refuse(c, vm, "reveal phase", c.reveal, one, 40 * MILLI, salt_for(P.alice), who=P.alice)
    reveal(c, vm, P.alice, one, 40 * MILLI, offset=BID_S + REVIEW_S)
    assert bid_row(c, one)["revealed"] is True


def test_the_last_second_of_the_reveal_phase_counts(c, vm, one):
    reveal(c, vm, P.alice, one, 40 * MILLI, offset=TOTAL - 1)
    assert bid_row(c, one)["revealed"] is True


def test_only_the_bidder_reveals(c, vm, one):
    at(vm, REVEAL_AT)
    for who in (P.curator, P.payee, P.bob, P.stranger):
        refuse(c, vm, "Only the bidder", c.reveal, one, 40 * MILLI, salt_for(P.alice), who=who)


def test_a_price_is_revealed_once(c, vm, one):
    reveal(c, vm, P.alice, one, 40 * MILLI, offset=REVEAL_AT)
    refuse(c, vm, "revealed already", c.reveal, one, 40 * MILLI, salt_for(P.alice), who=P.alice)


@pytest.mark.parametrize("amount,salt,msg", [
    (41 * MILLI, None, "do not match"), (40 * MILLI, "another-salt", "do not match"), (40 * MILLI - 1, None, "do not match"),
    (RESERVE - 1, None, "outside the slot's range"), (MAX_BID + 1, None, "outside the slot's range"), (-1, None, "outside the slot's range"),
    (0, None, "outside the slot's range"), (40 * MILLI, "short", "8 to 64"), (40 * MILLI, "x" * 65, "8 to 64"),
    (40 * MILLI, "has a space inside", "8 to 64"), (40 * MILLI, "slash/not/allowed", "8 to 64"), (40 * MILLI, "", "8 to 64"),
])
def test_a_wrong_reveal_is_refused_and_can_be_retried(c, vm, one, amount, salt, msg):
    at(vm, REVEAL_AT)
    refuse(c, vm, msg, c.reveal, one, amount, salt if salt is not None else salt_for(P.alice), who=P.alice)
    reveal(c, vm, P.alice, one, 40 * MILLI, offset=REVEAL_AT + 1)  # the right one still works
    assert bid_row(c, one)["amount"] == str(40 * MILLI)


@pytest.mark.parametrize("marks", [(0, 1, 0), (0, 2, 0)])
def test_only_a_cleared_bid_reveals(c, vm, sid, marks):
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI)
    screen(c, vm, P.stranger, bid_id, marks=marks, offset=REVIEW_AT)
    at(vm, REVEAL_AT)
    refuse(c, vm, "was cleared", c.reveal, bid_id, 40 * MILLI, salt_for(P.alice), who=P.alice)


def test_a_bid_nobody_read_cannot_reveal(c, vm, sid):
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI)
    at(vm, REVEAL_AT)
    refuse(c, vm, "was cleared", c.reveal, bid_id, 40 * MILLI, salt_for(P.alice), who=P.alice)


def test_a_commitment_cannot_be_copied_by_another_address(c, vm, sid):
    """Bob copies Alice's commitment text. He can never open it, because the bidder is part of the hash."""
    at(vm, 0)
    commit = commit_for(c, sid, P.alice, 90 * MILLI, "alice-secret-salt")
    act(vm, P.bob, MAX_BID)
    bob_bid = c.bid(sid, AD2, "", commit)
    vm.value = 0
    screen(c, vm, P.stranger, bob_bid, offset=REVIEW_AT)
    at(vm, REVEAL_AT)
    for amount in (90 * MILLI, RESERVE, MAX_BID):
        refuse(c, vm, "do not match", c.reveal, bob_bid, amount, "alice-secret-salt", who=P.bob)


def test_a_price_below_the_reserve_cannot_even_be_committed_usefully(c, vm, sid):
    """A bid that committed to a price outside the range simply cannot reveal and loses its forfeit."""
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, RESERVE - 1)
    screen(c, vm, P.stranger, bid_id, offset=REVIEW_AT)
    at(vm, REVEAL_AT)
    refuse(c, vm, "outside the slot's range", c.reveal, bid_id, RESERVE - 1, salt_for(P.alice), who=P.alice)
    settle(c, vm, sid, offset=SETTLE_AT)
    assert bid_row(c, bid_id)["outcome"] == OUT_FORFEITED


# ---- settle: prices and winners -------------------------------------------------------------------------------------


def settle_scenario(c, vm, sid, prices, ledger):
    """Everybody clears and reveals. Returns the bid ids."""
    who = [P.alice, P.bob, P.carol, P.dave][: len(prices)]
    ids = cleared_bids(c, vm, sid, list(zip(who, prices)))
    for i, w, p in zip(ids, who, prices):
        reveal(c, vm, w, i, p, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    return ids


def test_a_lone_bidder_pays_the_reserve(c, vm, sid, ledger):
    (a,) = settle_scenario(c, vm, sid, [70 * MILLI], ledger)
    r = round_row(c, 0)
    assert (r["stage"], r["winner"], r["price"], r["escrow"], r["valid"]) == (SETTLED, a, str(RESERVE), str(RESERVE), 1)
    assert ledger.to(P.alice) == MAX_BID - RESERVE and ledger.total() == MAX_BID - RESERVE
    assert bid_row(c, a)["outcome"] == OUT_WON and bid_row(c, a)["paid"] == str(RESERVE)
    assert books(c)["escrow_held"] == str(RESERVE) and books(c)["deposits_held"] == "0" and books(c)["balanced"]


def test_the_winner_pays_the_second_highest_price(c, vm, sid, ledger):
    a, b, d = settle_scenario(c, vm, sid, [30 * MILLI, 80 * MILLI, 55 * MILLI], ledger)
    r = round_row(c, 0)
    assert r["winner"] == b and r["price"] == str(55 * MILLI) and r["valid"] == 3
    assert ledger.to(P.bob) == MAX_BID - 55 * MILLI
    assert ledger.to(P.alice) == MAX_BID and ledger.to(P.carol) == MAX_BID
    assert [bid_row(c, i)["outcome"] for i in (a, b, d)] == [OUT_LOST, OUT_WON, OUT_LOST]
    assert books(c)["balanced"] and stats(c)["settled"] == 1


def test_a_tie_goes_to_the_earlier_bid_at_the_tied_price(c, vm, sid, ledger):
    a, b = settle_scenario(c, vm, sid, [60 * MILLI, 60 * MILLI], ledger)
    r = round_row(c, 0)
    assert r["winner"] == a and r["price"] == str(60 * MILLI)
    assert ledger.to(P.alice) == MAX_BID - 60 * MILLI and ledger.to(P.bob) == MAX_BID


def test_a_three_way_tie_and_a_tie_for_second_place(c, vm, sid, ledger):
    a, b, d = settle_scenario(c, vm, sid, [60 * MILLI, 60 * MILLI, 60 * MILLI], ledger)
    assert round_row(c, 0)["winner"] == a and round_row(c, 0)["price"] == str(60 * MILLI)


def test_a_tie_for_second_place_sets_the_price(c, vm, sid, ledger):
    a, b, d = settle_scenario(c, vm, sid, [90 * MILLI, 50 * MILLI, 50 * MILLI], ledger)
    assert round_row(c, 0)["winner"] == a and round_row(c, 0)["price"] == str(50 * MILLI)


def test_the_highest_price_may_be_the_deposit_and_the_lowest_the_reserve(c, vm, sid, ledger):
    a, b = settle_scenario(c, vm, sid, [MAX_BID, RESERVE], ledger)
    assert round_row(c, 0)["winner"] == a and round_row(c, 0)["price"] == str(RESERVE)
    assert ledger.to(P.alice) == MAX_BID - RESERVE


def test_a_winner_who_pays_the_whole_deposit_gets_nothing_back(c, vm, sid, ledger):
    a, b = settle_scenario(c, vm, sid, [MAX_BID, MAX_BID], ledger)
    assert round_row(c, 0)["price"] == str(MAX_BID)
    assert ledger.to(P.alice) == 0 and ledger.to(P.bob) == MAX_BID  # no zero-value transfer was sent
    assert all(v > 0 for _, v in ledger.sent)


def test_a_bid_that_is_not_cleared_does_not_count_however_high(c, vm, sid, ledger):
    at(vm, 0)
    low = place(c, vm, sid, P.alice, 20 * MILLI)
    high = place(c, vm, sid, P.bob, 99 * MILLI)  # never read: stays pending
    refused = place(c, vm, sid, P.carol, 98 * MILLI)
    screen(c, vm, P.stranger, low, offset=REVIEW_AT)
    screen(c, vm, P.stranger, refused, marks=(0, 2, 0), offset=REVIEW_AT)
    reveal(c, vm, P.alice, low, 20 * MILLI, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    r = round_row(c, 0)
    assert r["winner"] == low and r["price"] == str(RESERVE) and r["valid"] == 1
    assert ledger.to(P.bob) == MAX_BID and ledger.to(P.carol) == MAX_BID
    assert [bid_row(c, i)["outcome"] for i in (low, high, refused)] == [OUT_WON, OUT_EXCLUDED, OUT_EXCLUDED]


def test_the_second_price_ignores_bids_that_never_revealed(c, vm, sid, ledger):
    a, b = cleared_bids(c, vm, sid, [(P.alice, 50 * MILLI), (P.bob, 90 * MILLI)])  # bob is high but never reveals
    reveal(c, vm, P.alice, a, 50 * MILLI, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    assert round_row(c, 0)["winner"] == a and round_row(c, 0)["price"] == str(RESERVE)


def test_forfeits_go_to_the_beneficiary_and_the_rest_back(c, vm, sid, ledger):
    a, b = cleared_bids(c, vm, sid, [(P.alice, 50 * MILLI), (P.bob, 90 * MILLI)])
    reveal(c, vm, P.alice, a, 50 * MILLI, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    fee = MAX_BID * FORFEIT // 10_000
    assert bid_row(c, b)["outcome"] == OUT_FORFEITED and bid_row(c, b)["forfeited"] == str(fee)
    assert bid_row(c, b)["refunded"] == str(MAX_BID - fee)
    assert ledger.to(P.bob) == MAX_BID - fee and ledger.to(P.payee) == fee
    assert stats(c)["forfeits"] == str(fee) and books(c)["balanced"]


def test_excluded_bids_lose_nothing(c, vm, sid, ledger):
    at(vm, 0)
    ids = [place(c, vm, sid, w, 40 * MILLI) for w in (P.alice, P.bob, P.carol)]
    screen(c, vm, P.stranger, ids[0], marks=(0, 2, 0), offset=REVIEW_AT)
    screen(c, vm, P.stranger, ids[1], marks=(0, 1, 0), offset=REVIEW_AT)
    act(vm, P.curator)
    c.veto(ids[2], "Not for this corner, sorry.")
    settle(c, vm, sid, offset=SETTLE_AT)
    assert round_row(c, 0)["stage"] == VOID
    for who in (P.alice, P.bob, P.carol):
        assert ledger.to(who) == MAX_BID
    assert ledger.to(P.payee) == 0 and books(c)["balanced"] and books(c)["deposits_held"] == "0"


def test_a_void_round_returns_everything_and_displays_nothing(c, vm, sid, ledger):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    settle(c, vm, sid, offset=SETTLE_AT)
    r = round_row(c, 0)
    assert (r["stage"], r["winner"], r["price"], r["shown_until"]) == (VOID, -1, "0", 0)
    assert ledger.to(P.alice) == MAX_BID and current(c, sid)["occupied"] is False and stats(c)["void"] == 1
    assert slot_row(c, sid)["showing"] == -1


def test_an_empty_round_cannot_exist_and_a_settled_round_cannot_settle_again(c, vm, sid, ledger):
    refuse(c, vm, "nothing to settle", c.settle, sid, who=P.stranger)
    settle_scenario(c, vm, sid, [40 * MILLI], ledger)
    refuse(c, vm, "nothing to settle", c.settle, sid, who=P.stranger)


def test_settling_waits_for_the_end_of_the_reveal_phase(c, vm, sid):
    a = cleared_bid(c, vm, sid, P.alice, 40 * MILLI)
    for offset in (0, BID_S + REVIEW_S + 1, TOTAL - 1):
        at(vm, offset)
        refuse(c, vm, "not over yet", c.settle, sid, who=P.stranger)
    reveal(c, vm, P.alice, a, 40 * MILLI, offset=TOTAL - 1)
    settle(c, vm, sid, offset=TOTAL)  # the very second the reveal phase ends
    assert round_row(c, 0)["stage"] == SETTLED


def test_anyone_may_settle_even_much_later(c, vm, sid, ledger):
    a = cleared_bid(c, vm, sid, P.alice, 40 * MILLI)
    reveal(c, vm, P.alice, a, 40 * MILLI, offset=REVEAL_AT)
    late = TOTAL + 10 * HOLD
    settle(c, vm, sid, caller=P.dave, offset=late)  # long after the reveal phase ended
    r = round_row(c, 0)
    assert r["stage"] == SETTLED and r["shown_until"] == T0 + late + HOLD
    cur = current(c, sid)
    assert cur["occupied"] is True and cur["from"] == T0 + late  # a late settle never costs the winner display time
    at(vm, late + HOLD - 1)
    refuse(c, vm, "not ended", c.release, 0, who=P.stranger)
    at(vm, late + HOLD)
    act(vm, P.stranger)
    c.release(0)
    assert ledger.to(P.payee) == RESERVE and round_row(c, 0)["stage"] == RELEASED


def test_the_clock_of_the_display_starts_when_the_round_is_settled(c, vm, sid):
    a = cleared_bid(c, vm, sid, P.alice, 40 * MILLI, start=100)
    reveal(c, vm, P.alice, a, 40 * MILLI, offset=100 + REVEAL_AT)
    settle(c, vm, sid, offset=100 + TOTAL + 500)
    r = round_row(c, 0)
    assert r["shown_until"] == r["settled_at"] + HOLD and r["settled_at"] == T0 + 100 + TOTAL + 500 and r["settled_at"] > r["reveal_end"]


# ---- display, release, takedown -------------------------------------------------------------------------------------


@pytest.fixture
def shown(c, vm, sid, ledger):
    a, b = cleared_bids(c, vm, sid, [(P.alice, 70 * MILLI), (P.bob, 45 * MILLI)])
    reveal(c, vm, P.alice, a, 70 * MILLI, offset=REVEAL_AT)
    reveal(c, vm, P.bob, b, 45 * MILLI, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    return a


def test_the_winner_is_on_display_for_exactly_the_hold_time(c, vm, sid, shown):
    cur = current(c, sid)
    assert cur["occupied"] is True and cur["creative"] == AD and cur["price"] == str(45 * MILLI)
    assert cur["from"] == T0 + SETTLE_AT and cur["until"] == T0 + SETTLE_AT + HOLD and cur["bid"] == shown and cur["round"] == 0
    at(vm, SETTLE_AT + HOLD - 1)
    assert current(c, sid)["occupied"] is True
    at(vm, SETTLE_AT + HOLD)
    assert current(c, sid)["occupied"] is False


def test_the_link_is_part_of_what_is_on_display(c, vm, sid):
    at(vm, 0)
    a = place(c, vm, sid, P.alice, 70 * MILLI, link=LINK)
    screen(c, vm, P.stranger, a, offset=REVIEW_AT)
    reveal(c, vm, P.alice, a, 70 * MILLI, offset=REVEAL_AT)
    settle(c, vm, sid, offset=SETTLE_AT)
    assert current(c, sid)["link"] == LINK


def test_the_price_waits_in_escrow_until_the_display_ends(c, vm, sid, shown, ledger):
    assert ledger.to(P.payee) == 0 and books(c)["escrow_held"] == str(45 * MILLI)
    at(vm, SETTLE_AT + HOLD - 1)
    refuse(c, vm, "not ended", c.release, 0, who=P.stranger)
    at(vm, SETTLE_AT + HOLD)
    act(vm, P.stranger)
    c.release(0)
    assert ledger.to(P.payee) == 45 * MILLI
    r = round_row(c, 0)
    assert (r["stage"], r["escrow"]) == (RELEASED, "0")
    assert books(c)["escrow_held"] == "0" and books(c)["balanced"] and stats(c)["volume"] == str(45 * MILLI)
    refuse(c, vm, "no display to release", c.release, 0, who=P.stranger)


def test_release_needs_a_settled_round(c, vm, sid):
    at(vm, 0)
    place(c, vm, sid, P.alice, 40 * MILLI)
    refuse(c, vm, "no display to release", c.release, 0, who=P.stranger)
    refuse(c, vm, "No such round", c.release, 5, who=P.stranger)


@pytest.mark.parametrize("left,expected_refund", [(HOLD, 45 * MILLI), (HOLD // 2, 45 * MILLI // 2), (1, 45 * MILLI // HOLD), (HOLD - 1, 45 * MILLI * (HOLD - 1) // HOLD)])
def test_a_takedown_refunds_the_unused_time(c, vm, sid, shown, ledger, left, expected_refund):
    now = SETTLE_AT + HOLD - left
    at(vm, now)
    act(vm, P.curator)
    c.takedown(0, "The message turned out to be misleading.")
    price = 45 * MILLI
    r = round_row(c, 0)
    assert (r["stage"], r["escrow"], r["shown_until"], r["note"]) == (TAKEN_DOWN, "0", T0 + now, "The message turned out to be misleading.")
    refund = price * left // HOLD
    assert refund == expected_refund
    assert ledger.to(P.payee) == price - refund
    # the winner got the part of the deposit above the price at settle time plus the unused part of the price
    assert ledger.to(P.alice) == MAX_BID - price + refund
    assert books(c)["balanced"] and books(c)["escrow_held"] == "0" and stats(c)["takedowns"] == 1
    assert stats(c)["volume"] == str(price - refund)
    assert current(c, sid)["occupied"] is False


def test_a_takedown_at_the_very_start_refunds_everything(c, vm, sid, shown, ledger):
    at(vm, SETTLE_AT)
    act(vm, P.curator)
    c.takedown(0, "Taken down before anybody saw it.")
    assert ledger.to(P.payee) == 0 and ledger.to(P.alice) == MAX_BID  # the whole deposit came back, none of it was earned


def test_only_the_curator_takes_a_display_down(c, vm, sid, shown):
    at(vm, TOTAL + 10)
    for who in (P.alice, P.payee, P.stranger):
        refuse(c, vm, "Only the curator", c.takedown, 0, "I would like this gone now.", who=who)


@pytest.mark.parametrize("note", ["short", "x" * 201, "        "])
def test_a_takedown_needs_a_real_note(c, vm, shown, note):
    at(vm, TOTAL + 10)
    refuse(c, vm, "8 to 200", c.takedown, 0, note, who=P.curator)


def test_a_takedown_after_the_end_or_twice_is_refused(c, vm, sid, shown):
    at(vm, TOTAL + 10)
    act(vm, P.curator)
    c.takedown(0, "The message turned out to be misleading.")
    refuse(c, vm, "no display to take down", c.takedown, 0, "The message turned out to be misleading.", who=P.curator)
    refuse(c, vm, "no display to release", c.release, 0, who=P.stranger)


def test_a_display_that_ended_cannot_be_taken_down(c, vm, shown):
    at(vm, SETTLE_AT + HOLD)
    refuse(c, vm, "no display to take down", c.takedown, 0, "Too late for this one, sadly.", who=P.curator)


def test_the_curator_of_another_slot_cannot_take_a_display_down(c, vm, sid, shown):
    other = make_slot(c, vm, who=P.alice)
    at(vm, TOTAL + 10)
    refuse(c, vm, "Only the curator", c.takedown, 0, "This is not even my slot.", who=P.alice)


def test_the_previous_winner_leaves_when_the_next_one_arrives(c, vm, sid, shown, ledger):
    """A whole second round after the first: the old display ends exactly when the new one begins."""
    opens = HOLD + 1  # the earliest a bid can open the next round: it settles the second the old display ends
    at(vm, opens)
    a2 = cleared_bid(c, vm, sid, P.carol, 33 * MILLI, start=opens)
    reveal(c, vm, P.carol, a2, 33 * MILLI, offset=opens + REVEAL_AT)
    at(vm, TOTAL + HOLD - 1)
    assert current(c, sid)["bidder"].lower() == hx(P.alice)
    settle(c, vm, sid, offset=opens + TOTAL)
    assert round_row(c, 1)["reveal_end"] == round_row(c, 0)["shown_until"]
    cur = current(c, sid)
    assert cur["bidder"].lower() == hx(P.carol) and cur["round"] == 1
    assert slot_row(c, sid)["showing"] == 1
    # the first round can still be released afterwards
    act(vm, P.stranger)
    c.release(0)
    assert round_row(c, 0)["stage"] == RELEASED and books(c)["balanced"]
