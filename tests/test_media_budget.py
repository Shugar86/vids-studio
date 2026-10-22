import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import media_budget
from media_budget import acquire, budget_limit, clear, reserve, snapshot


class FixedResources:
    def __init__(self, cpu=95):
        self.cpu = cpu

    def sample(self):
        return {'memoryAvailableBytes': 8 * 1024**3, 'cpuPercent': self.cpu}


class MediaBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vids-media-budget-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / 'budget'
        mock = patch('media_budget.FleetRegistry')
        self.registry = mock.start()
        self.addCleanup(mock.stop)
        self.registry.return_value.snapshot.return_value = {'policy': {'paused': False, 'maxConcurrency': 10}}

    def worker(self, job='fixture', resources=None, wait=2):
        inbox, events = queue.Queue(), queue.Queue()
        thread = threading.Thread(target=acquire, args=(self.directory, {'jobId': job, 'ownerPid': os.getpid()}, inbox, events.put), kwargs={'resources': resources or FixedResources(), 'wait_seconds': wait})
        thread.start()
        self.addCleanup(lambda: (inbox.put(None), thread.join(3)))
        return thread, inbox, events

    def event(self, events, wanted):
        for _ in range(10):
            value = events.get(timeout=3)
            if value['event'] == wanted:
                return value
        self.fail(f'Missing {wanted}')

    def test_global_slot_is_not_reused_until_explicit_release(self):
        first, inbox, events = self.worker('first')
        lease = self.event(events, 'acquired')
        second, inbox2, events2 = self.worker('second')
        self.assertEqual(self.event(events2, 'waiting')['reason'], 'local_capacity')
        self.assertEqual(len(snapshot(self.directory)['slots']), 1)
        inbox.put({'action': 'release', 'leaseId': lease['leaseId']})
        self.event(events, 'released')
        lease2 = self.event(events2, 'acquired')
        self.assertNotEqual(lease['leaseId'], lease2['leaseId'])
        inbox2.put({'action': 'release', 'leaseId': lease2['leaseId']})
        first.join(2); second.join(2)
        self.assertEqual(snapshot(self.directory)['slots'], [])

    def test_pipe_loss_keeps_unconfirmed_marker_and_no_pid_or_timeout_reclaim(self):
        thread, inbox, events = self.worker()
        lease = self.event(events, 'acquired')
        with self.assertRaises(BlockingIOError):
            clear(self.directory, 0, lease['leaseId'])
        inbox.put(None); thread.join(2)
        new, _, events2 = self.worker('later')
        self.assertEqual(self.event(events2, 'error')['code'], 'MEDIA_PERMIT_UNCONFIRMED')
        new.join(2)
        self.assertEqual(snapshot(self.directory)['slots'][0]['leaseId'], lease['leaseId'])
        with self.assertRaises(ValueError):
            clear(self.directory, 0, 'wrong-id')
        clear(self.directory, 0, lease['leaseId'])
        self.assertEqual(snapshot(self.directory)['slots'], [])

    def test_metrics_allow_at_most_two_and_global_pause_admits_none(self):
        self.assertEqual(budget_limit({}), 1)
        self.assertEqual(budget_limit({'memoryAvailableBytes': 100}), 0)
        self.assertEqual(budget_limit(FixedResources(10).sample()), 2)
        self.registry.return_value.snapshot.return_value = {'policy': {'paused': True, 'maxConcurrency': 50}}
        thread, _, events = self.worker(wait=.05)
        self.assertEqual(self.event(events, 'waiting')['effectiveSlots'], 0)
        self.assertEqual(self.event(events, 'error')['code'], 'MEDIA_CAPACITY_TIMEOUT')
        thread.join(2)
        self.assertEqual(snapshot(self.directory)['slots'], [])

    def test_status_of_missing_directory_is_read_only(self):
        self.assertEqual(snapshot(self.directory)['slots'], [])
        self.assertFalse(self.directory.exists())

    def test_downshift_counts_work_in_second_slot_before_admitting_more(self):
        first, inbox, events = self.worker('first', FixedResources(10))
        lease = self.event(events, 'acquired')
        second, inbox2, events2 = self.worker('second', FixedResources(10))
        lease2 = self.event(events2, 'acquired')
        self.assertEqual(lease['slot'], 0); self.assertEqual(lease2['slot'], 1)
        inbox.put({'action': 'release', 'leaseId': lease['leaseId']}); first.join(2)
        third, inbox3, events3 = self.worker('third', FixedResources(95))
        self.assertEqual(self.event(events3, 'waiting')['effectiveSlots'], 1)
        self.assertEqual(len(snapshot(self.directory)['slots']), 1)
        inbox2.put({'action': 'release', 'leaseId': lease2['leaseId']}); second.join(2)
        lease3 = self.event(events3, 'acquired')
        inbox3.put({'action': 'release', 'leaseId': lease3['leaseId']}); third.join(2)

    def test_marker_disappearance_never_reuses_a_still_locked_slot(self):
        media_budget.ensure_private_directory(self.directory)
        held, stale = reserve(self.directory, {'jobId': 'first', 'ownerPid': os.getpid()}, 1)
        fd, _, marker, _ = held
        original_read = media_budget.read_marker
        def remove_before_read(path):
            marker.unlink()
            return original_read(path)
        try:
            # Normal release deletes metadata just before closing its OS lock.
            # A scan that already saw the marker must tolerate that unlink,
            # but its keeper still occupies capacity until the lock closes.
            with patch('media_budget.read_marker', side_effect=remove_before_read):
                admitted, _ = reserve(self.directory, {'jobId': 'second', 'ownerPid': os.getpid()}, 1)
            self.assertIsNone(admitted)
            admitted, _ = reserve(self.directory, {'jobId': 'third', 'ownerPid': os.getpid()}, 1)
            self.assertIsNone(admitted, 'Missing metadata must not hide the still-held OS lock')
            self.assertFalse((self.directory / 'slot-1.json').exists())
        finally:
            os.close(fd)
        admitted, _ = reserve(self.directory, {'jobId': 'after-close', 'ownerPid': os.getpid()}, 1)
        self.assertIsNotNone(admitted)
        os.close(admitted[0])
        clear(self.directory, admitted[1], admitted[3])

    def test_snapshot_tolerates_a_released_marker_but_keeps_validation_failures(self):
        media_budget.ensure_private_directory(self.directory)
        held, _ = reserve(self.directory, {'jobId': 'first', 'ownerPid': os.getpid()}, 1)
        fd, _, marker, _ = held
        original_read = media_budget.read_marker
        def remove_before_read(path):
            marker.unlink()
            return original_read(path)
        try:
            with patch('media_budget.read_marker', side_effect=remove_before_read):
                self.assertEqual(snapshot(self.directory)['slots'], [])
        finally:
            os.close(fd)
        for failure in (PermissionError('unsafe ACL'), ValueError('malformed marker')):
            marker.write_text('{}')
            marker.chmod(0o600)
            with patch('media_budget.read_marker', side_effect=failure):
                with self.assertRaises(type(failure)):
                    snapshot(self.directory)
                with self.assertRaises(type(failure)):
                    reserve(self.directory, {'jobId': 'blocked', 'ownerPid': os.getpid()}, 1)
            marker.unlink()


if __name__ == '__main__':
    unittest.main()
