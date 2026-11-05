import json

from conftest import *


def test_deploys_and_runs_the_happy_path(direct_vm, direct_deploy, ledger):
    c = deploy(direct_deploy, direct_vm)
    sid = make_slot(c, direct_vm, beneficiary=P.payee)
    ids = run_round(c, direct_vm, sid, [P.alice, P.bob], [50 * MILLI, 30 * MILLI])
    row = round_row(c, 0)
    assert row["stage"] == SETTLED and row["winner"] == ids[0] and row["price"] == str(30 * MILLI)
    cur = current(c, sid)
    assert cur["occupied"] and cur["bidder"].lower() == hx(P.alice) and cur["creative"] == AD
    # the winner got back the part of the deposit above the price, the loser everything
    assert ledger.to(P.alice) == MAX_BID - 30 * MILLI and ledger.to(P.bob) == MAX_BID
    assert books(c)["balanced"]
    at(direct_vm, TOTAL + HOLD + 5)
    act(direct_vm, P.stranger)
    c.release(0)
    assert ledger.to(P.payee) == 30 * MILLI
    assert books(c)["balanced"] and round_row(c, 0)["stage"] == RELEASED
