"""The validator side: when does the network accept a leader's read, and do the closures travel?"""

import cloudpickle
import sys

import pytest

from conftest import *

REVIEW_AT = BID_S + 5


@pytest.fixture
def c(direct_vm, direct_deploy):
    return deploy(direct_deploy, direct_vm)


@pytest.fixture
def vm(direct_vm):
    return direct_vm


@pytest.fixture
def mod(c):
    return sys.modules[MODULE]


@pytest.fixture
def sid(c, vm):
    return make_slot(c, vm)


def ok(marks=(0, 0, 0), reason="fine"):
    return {"kind": "OK", "marks": list(marks), "reason": reason}


UNREAD = {"kind": "UNREADABLE"}

# (label, leader's result, validator's own result, lenient, expected)
ACCEPT = [
    ("same marks", ok(), ok(), False, True),
    ("same verdict, different marks", ok((0, 1, 0)), ok((1, 0, 1)), False, True),
    ("same refusal, different marks", ok((2, 0, 0)), ok((0, 0, 2)), False, True),
    ("leader one step stricter (unsure vs clear)", ok((0, 1, 0)), ok(), False, True),
    ("leader one step stricter (refused vs unsure)", ok((0, 2, 0)), ok((0, 1, 0)), False, True),
    ("leader two steps stricter", ok((0, 2, 0)), ok(), False, False),
    ("leader milder (clear vs unsure)", ok(), ok((0, 1, 0)), False, False),
    ("leader milder (unsure vs refused)", ok((0, 1, 0)), ok((0, 2, 0)), False, False),
    ("leader milder by two", ok(), ok((0, 2, 0)), False, False),
    ("both unreadable", UNREAD, UNREAD, False, True),
    ("leader read what the validator could not", ok(), UNREAD, False, False),
    ("leader could not read what the validator read", UNREAD, ok(), False, False),
    ("reason with angle brackets", ok(reason="<b>x</b>"), ok(), False, False),
    ("reason too long", ok(reason="r" * 161), ok(), False, False),
    ("reason at the limit", ok(reason="r" * 160), ok(), False, True),
    ("reason is not text", ok(reason=5), ok(), False, False),
    ("reason is missing", {"kind": "OK", "marks": [0, 0, 0]}, ok(), False, False),
    ("too few marks", ok((0, 0)), ok(), False, False),
    ("too many marks", ok((0, 0, 0, 0)), ok(), False, False),
    ("mark out of range", ok((0, 3, 0)), ok(), False, False),
    ("negative mark", ok((0, -1, 0)), ok(), False, False),
    ("string marks", {"kind": "OK", "marks": ["0", "0", "0"], "reason": "x"}, ok(), False, False),
    ("bool marks", {"kind": "OK", "marks": [False, False, False], "reason": "x"}, ok(), False, False),
    ("float marks", {"kind": "OK", "marks": [0.0, 0.0, 0.0], "reason": "x"}, ok(), False, False),
    ("marks not a list", {"kind": "OK", "marks": "000", "reason": "x"}, ok(), False, False),
    ("no marks", {"kind": "OK", "reason": "x"}, ok(), False, False),
    ("unknown kind", {"kind": "MAYBE"}, ok(), False, False),
    ("not a dict", "OK", ok(), False, False),
    ("none", None, ok(), False, False),
    ("a list", [ok()], ok(), False, False),
    ("empty dict", {}, ok(), False, False),
    ("a verdict the marks do not support", {"kind": "OK", "marks": [2, 2, 2], "verdict": "CLEARED", "reason": "x"}, ok((2, 2, 2)), False, True),
    # an appeal reads leniently: the only outcomes are UNSURE (promoted) and REFUSED
    ("appeal: both promote", ok((0, 0, 0)), ok((0, 1, 0)), True, True),
    ("appeal: both refuse", ok((0, 2, 0)), ok((2, 0, 0)), True, True),
    ("appeal: leader refuses, validator would promote", ok((0, 2, 0)), ok(), True, True),
    ("appeal: leader promotes, validator would refuse", ok(), ok((0, 2, 0)), True, False),
    ("appeal: one unsure mark is still a promotion", ok((1, 1, 1)), ok(), True, True),
]


@pytest.mark.parametrize("label,theirs,mine,lenient,expected", ACCEPT, ids=[x[0] for x in ACCEPT])
def test_accepts(mod, label, theirs, mine, lenient, expected):
    assert mod._accepts(theirs, mine, 3, lenient) is expected


def test_the_rule_never_accepts_a_milder_read_than_the_validators_own(mod):
    """Exhaustive: over every pair of mark lists, a milder leader is never accepted."""
    import itertools
    rank = {CLEARED: 0, UNSURE: 1, REFUSED: 2}
    for lenient in (False, True):
        for theirs in itertools.product(range(3), repeat=3):
            for mine in itertools.product(range(3), repeat=3):
                got = mod._accepts(ok(theirs), ok(mine), 3, lenient)
                step = rank[mod._verdict(theirs, lenient)] - rank[mod._verdict(mine, lenient)]
                assert got == (step in (0, 1)), (theirs, mine, lenient)


def test_accepts_never_raises_on_hostile_shapes(mod):
    junk = [None, 0, 1.5, "x", b"x", [], {}, {"kind": "OK"}, {"kind": "OK", "marks": None}, {"kind": "OK", "marks": [{}] * 3},
            {"kind": "OK", "marks": [[0]] * 3, "reason": "x"}, {"kind": ["OK"]}, {"kind": {"a": 1}}, {"kind": "OK", "marks": [0, 0, 0], "reason": ["x"]},
            {"kind": "OK", "marks": [10**40, 0, 0], "reason": "x"}, {"kind": "OK", "marks": ["9" * 30, 0, 0], "reason": "x"}]
    for theirs in junk:
        for lenient in (False, True):
            assert mod._accepts(theirs, ok(), 3, lenient) is False


def test_a_single_rule_slot_works_the_same_way(mod):
    assert mod._accepts(ok((0,)), ok((0,)), 1, False) is True
    assert mod._accepts(ok((2,)), ok((0,)), 1, False) is False
    assert mod._accepts(ok((0, 0)), ok((0,)), 1, False) is False


# ---- the real validator closure -------------------------------------------------------------------------------------


def screened(c, vm, sid, marks):
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI)
    screen(c, vm, P.stranger, bid_id, marks=marks, offset=REVIEW_AT)
    return bid_id


def test_the_validator_accepts_the_same_read(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))
    assert vm.run_validator() is True


def test_the_validator_accepts_a_stricter_leader(c, vm, sid):
    screened(c, vm, sid, (0, 1, 0))  # the leader was unsure
    vm.clear_mocks()
    mock_gate(vm, (0, 0, 0))  # the validator would have cleared it
    assert vm.run_validator() is True


def test_the_validator_rejects_a_milder_leader(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))  # the leader cleared it
    vm.clear_mocks()
    mock_gate(vm, (0, 1, 0))  # the validator is unsure
    assert vm.run_validator() is False
    vm.clear_mocks()
    mock_gate(vm, (0, 2, 0))
    assert vm.run_validator() is False


def test_the_validator_rejects_a_made_up_refusal(c, vm, sid):
    screened(c, vm, sid, (0, 2, 0))  # the leader refused
    vm.clear_mocks()
    mock_gate(vm, (0, 0, 0))  # the validator would have cleared it: two steps apart
    assert vm.run_validator() is False


def test_the_validator_rejects_a_forged_leader_result(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))
    vm.clear_mocks()
    mock_gate(vm, (0, 2, 0))
    for forged in (ok((0, 0, 0)), ok((0, 0)), {"kind": "OK", "marks": [0, 0, 0], "reason": "<x>"}, "CLEARED", None, {"kind": "UNREADABLE"}):
        assert vm.run_validator(leader_result=forged) is False


def test_a_leader_that_failed_is_not_accepted(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))
    assert vm.run_validator(leader_error=Exception("boom")) is False


def test_a_validator_that_cannot_read_rejects_a_leader_that_could(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))
    vm.clear_mocks()
    mock_gate(vm, raw="gibberish")
    assert vm.run_validator() is False
    assert vm.run_validator(leader_result=UNREAD) is True  # both failed: they agree


def test_the_appeal_validator_reads_leniently_and_never_accepts_a_milder_leader(c, vm, sid):
    at(vm, 0)
    bid_id = place(c, vm, sid, P.alice, 40 * MILLI)
    screen(c, vm, P.stranger, bid_id, marks=(0, 2, 0), offset=REVIEW_AT)
    appeal(c, vm, P.alice, bid_id, marks=(0, 0, 0), offset=REVIEW_AT + 10)  # leader promotes
    assert vm.run_validator() is True
    vm.clear_mocks()
    mock_appeals(vm, (0, 2, 0))  # a validator that would still refuse
    assert vm.run_validator() is False
    assert vm.run_validator(leader_result=ok((0, 2, 0))) is True  # a leader that refuses is never milder than that


def test_the_closures_are_picklable(c, vm, sid):
    """The direct runner pickles what is handed to the VM (check_pickling); do it by hand as well."""
    screened(c, vm, sid, (0, 0, 0))
    _, leader_fn, validator_fn = vm._captured_validators[-1]
    cloudpickle.dumps(leader_fn)
    cloudpickle.dumps(validator_fn)


def test_the_closures_capture_only_plain_values(c, vm, sid):
    screened(c, vm, sid, (0, 0, 0))
    _, leader_fn, validator_fn = vm._captured_validators[-1]
    for fn in (leader_fn, validator_fn):
        for cell in fn.__closure__ or ():
            value = cell.cell_contents
            assert isinstance(value, (str, int, bool, list, type(None))), type(value)
            if isinstance(value, list):
                assert all(isinstance(x, str) for x in value)
