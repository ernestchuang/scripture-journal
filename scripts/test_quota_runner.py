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
    Path(sys.argv[sys.argv.index('-o')+1]).write_text(json.dumps({'status':'continue','summary':'Checkpoint saved'}))
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


if __name__ == "__main__":
    unittest.main()
