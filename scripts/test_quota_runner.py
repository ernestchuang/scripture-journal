import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("quota_runner", Path(__file__).with_name("quota_runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def quota(primary=10, secondary=20, primary_reset=1500, secondary_reset=9000):
    return {"rateLimits": {"primary": {"usedPercent": primary, "resetsAt": primary_reset},
                           "secondary": {"usedPercent": secondary, "resetsAt": secondary_reset}}}


class QuotaRunnerTests(unittest.TestCase):
    def test_complex_coding_uses_stronger_role_but_review_takes_priority(self):
        state = {"review_initialized": True, "next_kind": "complex", "next_task": "Diagnose a save race"}
        self.assertEqual(runner.choose_role(state, True, True, 4, True), "complex")
        self.assertEqual(runner.choose_role(state, True, True, 4, False), "coding")
        state["completion_pending"] = True
        self.assertEqual(runner.choose_role(state, True, True, 4, True), "review")

    def test_no_monitor_resumes_checkpoint_without_quota_calls(self):
        for fails in (False, True):
            with self.subTest(fails=fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                common = root / "git"
                state_dir = common / "quota-runner"
                state_dir.mkdir(parents=True)
                runner.write_json(state_dir / "state.json", {"worktree": str(root), "issue": "sj-kfw",
                    "status": "blocked", "summary": "Native test needs diagnosis", "thread": "saved-session"})
                result = None if fails else {"status": "done", "summary": "Verified", "next_kind": "coding", "next_task": ""}
                with patch("sys.argv", ["runner", "--worktree", str(root), "--no-quota-monitor", "--resume-blocked", "--max-turns", "1"]), \
                     patch.object(runner.subprocess, "check_output", side_effect=[str(common), str(common / "worktrees" / "test")]), \
                     patch.object(runner, "read_quota", side_effect=AssertionError("Quota must not be read")) as checks, \
                     patch.object(runner, "execute_unit", return_value=result) as worker:
                    if fails:
                        with self.assertRaisesRegex(RuntimeError, "monitoring is disabled"):
                            runner.main()
                    else:
                        runner.main()
                    self.assertEqual(worker.call_args.args[3]["thread"], "saved-session")
                    checks.assert_not_called()

    def test_routing_reviews_first_and_bounds_time_between_reviews(self):
        self.assertEqual(runner.choose_role({}, True, True, 4), "review")
        state = {"review_initialized": True, "units_since_review": 0}
        self.assertEqual(runner.choose_role(state, True, True, 4), "coding")
        state.update(next_kind="routine", next_task="Adjust button spacing")
        self.assertEqual(runner.choose_role(state, True, True, 4), "routine")
        state["next_task"] = ""
        self.assertEqual(runner.choose_role(state, True, True, 4), "coding")
        state["units_since_review"] = 4
        self.assertEqual(runner.choose_role(state, True, True, 4), "review")
        state.update(units_since_review=0, next_kind="review")
        self.assertEqual(runner.choose_role(state, True, True, 4), "review")

    def test_worker_cannot_complete_without_review(self):
        state = {"review_initialized": True}
        result = {"status": "done", "summary": "Candidate complete", "next_kind": "coding", "next_task": ""}
        runner.record_result(state, result, "coding", True)
        self.assertEqual(state["status"], "continue")
        self.assertEqual(runner.choose_role(state, True, True, 4), "review")
        runner.record_result(state, {**result, "status": "continue", "next_task": "Fix race"}, "review", True)
        self.assertFalse(state["completion_pending"])
        self.assertEqual(runner.choose_role(state, True, True, 4), "coding")
        runner.record_result(state, result, "coding", True)
        runner.record_result(state, result, "review", True)
        self.assertEqual(state["status"], "done")

    def test_preserves_reserve_and_observes_longer_window(self):
        self.assertIsNone(runner.quota_decision(quota(), 80, 1000)[1])
        self.assertEqual(runner.quota_decision(quota(primary=80), 80, 1000)[1], 1560)
        self.assertEqual(runner.quota_decision(quota(primary=95, secondary=85), 80, 1000)[1], 9060)

    def test_stale_reset_has_backoff(self):
        self.assertEqual(runner.quota_decision(quota(primary=100, primary_reset=10), 80, 1000)[1], 1300)

    def test_primary_only_ignores_weekly_reserve(self):
        windows, wake = runner.quota_decision(quota(primary=5, secondary=84), 80, 1000, "primary")
        self.assertEqual(len(windows), 2)
        self.assertIsNone(wake)
        self.assertEqual(runner.quota_decision(quota(primary=85, secondary=95), 80, 1000, "primary")[1], 1560)

    def test_primary_only_does_not_override_provider_denial(self):
        with self.assertRaises(ValueError):
            runner.quota_decision({**quota(primary=5, secondary=100), "ordinaryUsageAllowed": False}, 80, 1000, "primary")

    def test_primary_only_requires_primary_window(self):
        result = quota()
        del result["rateLimits"]["primary"]
        with self.assertRaises(ValueError):
            runner.quota_decision(result, 80, 1000, "primary")

    def test_unknown_limits_fail_closed(self):
        for result in ({}, {"rateLimits": {}}, quota(primary=100, primary_reset=None),
                       quota(primary=float("nan")), {**quota(), "ordinaryUsageAllowed": False}):
            with self.assertRaises(ValueError):
                runner.quota_decision(result, 80, 1000)

    def test_all_reported_buckets_are_considered(self):
        result = {"rateLimitsByLimitId": {"a": quota()["rateLimits"],
                                         "b": quota(secondary=90)["rateLimits"]}}
        windows, wake = runner.quota_decision(result, 80, 1000)
        self.assertEqual(len(windows), 4)
        self.assertEqual(wake, 9060)

    def test_sleep_does_not_invoke_worker_and_resumes_after_recheck(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            common = root / "git"
            common.mkdir()
            clock = [1000]
            calls = []

            def sleep(seconds):
                self.assertEqual(calls, [])
                clock[0] += seconds

            def worker(*args):
                calls.append(clock[0])
                return {"status": "done", "summary": "Test checkpoint"}

            with patch("sys.argv", ["runner", "--worktree", str(root), "--max-turns", "1"]), \
                 patch.object(runner.subprocess, "check_output", side_effect=[str(common), str(common / "worktrees" / "test")]), \
                 patch.object(runner, "read_quota", side_effect=[quota(primary=90), quota()]) as checks, \
                 patch.object(runner.time, "time", side_effect=lambda: clock[0]), \
                 patch.object(runner.time, "sleep", side_effect=sleep), \
                 patch.object(runner, "execute_unit", side_effect=worker):
                runner.main()
            self.assertEqual(checks.call_count, 2)
            self.assertEqual(calls, [1560])

    def test_live_protocol_and_worker_with_fake_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "codex"
            fake.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
if sys.argv[1] == 'app-server':
    for line in sys.stdin:
        request = json.loads(line)
        if request.get('method') == 'initialize':
            print(json.dumps({'id':request['id'], 'result':{}}), flush=True)
        elif request.get('method') == 'account/rateLimits/read':
            print(json.dumps({'id':request['id'], 'result':{'rateLimits':{'primary':{'usedPercent':12,'resetsAt':9999}}}}), flush=True)
else:
    prompt = sys.stdin.read()
    assert 'ONE small' in prompt
    assert sys.argv[sys.argv.index('--model')+1] == 'gpt-5.6-luna'
    print(json.dumps({'type':'thread.started','thread_id':'test-thread'}), flush=True)
    Path(sys.argv[sys.argv.index('-o')+1]).write_text(json.dumps({'status':'continue','summary':'Checkpoint saved','next_kind':'coding','next_task':'Next task'}))
''')
            fake.chmod(0o700)
            self.assertEqual(runner.read_quota(str(fake))["rateLimits"]["primary"]["usedPercent"], 12)
            state = {}
            result = runner.execute_unit(str(fake), root, root, state, "sj-example", "gpt-5.6-luna")
            self.assertEqual(result["status"], "continue")
            self.assertEqual(state["thread"], "test-thread")
            self.assertEqual(json.loads((root / "state.json").read_text())["thread"], "test-thread")
            # A second unit explicitly resumes the same saved session.
            self.assertEqual(runner.execute_unit(str(fake), root, root, state, "sj-example", "gpt-5.6-luna")["status"], "continue")

    def test_review_starts_fresh_and_preserves_coding_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "codex"
            fake.write_text('''#!/usr/bin/env python3
import json, sys
from pathlib import Path
assert 'resume' not in sys.argv
assert sys.argv[sys.argv.index('--model')+1] == 'gpt-6-astra'
assert 'independent reviewer' in sys.stdin.read()
print(json.dumps({'type':'thread.started','thread_id':'review-session'}), flush=True)
Path(sys.argv[sys.argv.index('-o')+1]).write_text(json.dumps({'status':'continue','summary':'Needs fixes','next_kind':'coding','next_task':'Fix identified race'}))
''')
            fake.chmod(0o700)
            state = {"thread": "coding-session", "review_thread": "older-review"}
            runner.execute_unit(str(fake), root, root, state, "sj-example", "gpt-6-astra", "review", True)
            self.assertEqual(state["thread"], "coding-session")
            self.assertEqual(state["review_thread"], "review-session")


if __name__ == "__main__":
    unittest.main()
