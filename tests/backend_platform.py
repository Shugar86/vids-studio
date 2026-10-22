"""Platform storage and Windows transport authentication without a live browser."""
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend_native import bridge
from platform_support import ensure_private_directory, secure_open, assert_private_file, lock_file
from platform_smoke import private_temporary_directory


class TransportAuthenticationTests(unittest.TestCase):
    def authenticate(self, client_nonce="a" * 64, valid=True):
        server, client = socket.socketpair()
        server.settimeout(2)
        client.settimeout(2)
        host = bridge.Bridge(Path.home().resolve() / "unused", stdout=io.BytesIO())
        host.transport_secret = "b" * 64
        outcome = []

        def serve():
            try:
                outcome.append(host._authenticate_windows(server))
            except Exception as exc:
                outcome.append(exc)
            finally:
                server.close()

        thread = threading.Thread(target=serve)
        thread.start()
        try:
            client.sendall((json.dumps({"v": 1, "type": "transport_hello", "nonce": client_nonce}) + "\n").encode())
            if len(client_nonce) == 64:
                response = bridge.Bridge._read_line(client, 4096)
                proof = lambda role: hmac.new(bytes.fromhex(host.transport_secret), f"{role}:{client_nonce}:{response['nonce']}".encode(), hashlib.sha256).hexdigest()
                self.assertEqual(response["proof"], proof("server"))
                self.assertNotIn(host.transport_secret, json.dumps(response))
                request = {"method": "observe", "params": {}, "transportProof": proof("client") if valid else "0" * 64}
                client.sendall((json.dumps(request) + "\n").encode())
            thread.join(3)
            self.assertFalse(thread.is_alive())
            return outcome[0]
        finally:
            client.close()
            thread.join(3)

    def test_server_proves_identity_before_request_and_client_proof_is_not_forwarded(self):
        request = self.authenticate()
        self.assertEqual(request, {"method": "observe", "params": {}})

    def test_invalid_client_proof_and_malformed_nonce_never_reach_dispatch(self):
        self.assertIsInstance(self.authenticate(valid=False), PermissionError)
        self.assertIsInstance(self.authenticate(client_nonce="bad"), ValueError)


class PrivatePlatformTests(unittest.TestCase):
    def test_media_marker_unlink_keeps_capacity_until_native_lock_closes(self):
        import media_budget as media
        with private_temporary_directory(Path.home().resolve()) as directory:
            private = directory / 'media'
            ensure_private_directory(private)
            held, _ = media.reserve(private, {'jobId': 'first', 'ownerPid': os.getpid()}, 1)
            fd, _, marker, _ = held
            original_read = media.read_marker
            def unlink_before_read(path):
                marker.unlink()
                return original_read(path)
            try:
                with patch.object(media, 'read_marker', side_effect=unlink_before_read):
                    self.assertIsNone(media.reserve(private, {'jobId': 'raced', 'ownerPid': os.getpid()}, 1)[0])
                self.assertIsNone(media.reserve(private, {'jobId': 'later', 'ownerPid': os.getpid()}, 1)[0])
            finally:
                os.close(fd)
            admitted, _ = media.reserve(private, {'jobId': 'after-close', 'ownerPid': os.getpid()}, 1)
            self.assertIsNotNone(admitted)
            os.close(admitted[0])
            media.clear(private, admitted[1], admitted[3])

    def test_windows_concurrent_creation_revalidates_every_co_created_directory(self):
        # Model the exact check/CreateDirectory race on every OS. The native
        # Windows test below also exercises real protected directory creation.
        import platform_support as security
        parent = Path.home().resolve()
        target = parent / 'fixture-raced-directory'
        class WindowsError(Exception):
            def __init__(self, number):
                self.winerror = number
        for obstruction in (None, 'widened ACL', 'reparse point', 'not a directory'):
            with self.subTest(obstruction=obstruction):
                created = False
                checks = []
                def check(path, **options):
                    checks.append((path, options))
                    if path == target and not created:
                        raise FileNotFoundError()
                    if path == target and created:
                        self.assertEqual(options, {'private': True, 'directory': True})
                        if obstruction:
                            raise PermissionError(obstruction)
                def create(path, attributes):
                    nonlocal created
                    created = True
                    raise WindowsError(183)
                with patch.object(security, '_windows_path', return_value=(target, [parent, target])), \
                     patch.object(security, '_windows_check', side_effect=check), \
                     patch.object(security, '_attributes', return_value=object()), \
                     patch.object(security, 'win32file', SimpleNamespace(CreateDirectory=create), create=True), \
                     patch.object(security, 'pywintypes', SimpleNamespace(error=WindowsError), create=True):
                    if obstruction:
                        with self.assertRaisesRegex(PermissionError, obstruction):
                            security._windows_ancestors(target, create=True)
                    else:
                        self.assertEqual(security._windows_ancestors(target, create=True), target)
                self.assertEqual(checks[-1], (target, {'private': True, 'directory': True}))

    @unittest.skipUnless(os.name == "nt", "Real Windows concurrent directory creation")
    def test_windows_create_race_checks_real_private_acl_and_file_type(self):
        import platform_support as security
        from platform_smoke import widen_access
        with private_temporary_directory(Path.home().resolve()) as directory:
            original_create = security.win32file.CreateDirectory
            junction_target = directory / 'junction-target'
            ensure_private_directory(junction_target)
            for obstruction in (None, 'widened ACL', 'not a directory', 'reparse point'):
                target = directory / ('raced-' + str(obstruction))
                def raced_create(path, attributes):
                    if obstruction == 'not a directory':
                        descriptor = secure_open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                        os.close(descriptor)
                    elif obstruction == 'reparse point':
                        # Directory junctions need no symlink privilege. The
                        # post-race check must reject the real reparse flag.
                        subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', path, str(junction_target)],
                                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    else:
                        original_create(path, attributes)
                        if obstruction == 'widened ACL':
                            widen_access(Path(path))
                    raise security.pywintypes.error(183, 'CreateDirectory', 'Already exists')
                with self.subTest(obstruction=obstruction), patch.object(security.win32file, 'CreateDirectory', side_effect=raced_create):
                    if obstruction:
                        with self.assertRaises(PermissionError):
                            ensure_private_directory(target)
                    else:
                        self.assertEqual(ensure_private_directory(target), target)
                if obstruction == 'widened ACL':
                    # Rejection must not repair the foreign grant.
                    with self.assertRaises(PermissionError):
                        ensure_private_directory(target)

    def test_regular_private_file_and_two_independent_lock_handles(self):
        with private_temporary_directory(Path.home().resolve()) as directory:
            private = directory / "private"
            ensure_private_directory(private)
            first = secure_open(private / "owner.lock", os.O_CREAT | os.O_RDWR)
            second = secure_open(private / "owner.lock", os.O_CREAT | os.O_RDWR)
            try:
                assert_private_file(private / "owner.lock")
                lock_file(first)
                with self.assertRaises(BlockingIOError):
                    lock_file(second)
            finally:
                os.close(first)
                os.close(second)
            third = secure_open(private / "owner.lock", os.O_RDWR)
            try:
                lock_file(third)
            finally:
                os.close(third)

    @unittest.skipUnless(os.name == "nt", "Windows DACL behavior")
    def test_private_directory_rejects_a_foreign_read_grant_without_repair(self):
        import platform_support as security
        with private_temporary_directory(Path.home().resolve()) as directory:
            private = directory / "private"
            ensure_private_directory(private)
            descriptor = security.win32security.GetNamedSecurityInfo(str(private), security.win32security.SE_FILE_OBJECT, security.win32security.DACL_SECURITY_INFORMATION)
            acl = descriptor.GetSecurityDescriptorDacl()
            acl.AddAccessAllowedAce(security.win32security.ACL_REVISION, security.win32con.GENERIC_READ, security.win32security.ConvertStringSidToSid("S-1-1-0"))
            security.win32security.SetNamedSecurityInfo(str(private), security.win32security.SE_FILE_OBJECT, security.win32security.DACL_SECURITY_INFORMATION, None, None, acl, None)
            with self.assertRaises(PermissionError):
                ensure_private_directory(private)
            after = security.win32security.GetNamedSecurityInfo(str(private), security.win32security.SE_FILE_OBJECT, security.win32security.DACL_SECURITY_INFORMATION)
            self.assertEqual(after.GetSecurityDescriptorDacl().GetAceCount(), acl.GetAceCount())

    @unittest.skipUnless(os.name == "nt", "Windows filename aliases and alternate streams")
    def test_file_basename_aliases_are_rejected_before_read_or_creation(self):
        import platform_support as security
        with private_temporary_directory(Path.home().resolve()) as directory:
            private = directory / "private"
            ensure_private_directory(private)
            target = private / "existing.txt"
            security.create_private_file(target)
            for suffix in (":stream", ".", " "):
                for check in (security.assert_owned_file, assert_private_file):
                    with self.subTest(suffix=suffix, check=check.__name__):
                        with self.assertRaises(PermissionError):
                            check(Path(str(target) + suffix))
                with self.assertRaises(PermissionError):
                    secure_open(private / f"new{suffix}", os.O_CREAT | os.O_WRONLY | os.O_EXCL)
            self.assertEqual(sorted(item.name for item in private.iterdir()), ["existing.txt"])

    @unittest.skipIf(os.name == "nt", "Windows reparse/ACL checks run in native platform CI")
    def test_existing_shared_directory_and_symlink_file_are_not_repaired(self):
        with private_temporary_directory(Path.home().resolve()) as root:
            shared = root / "shared"
            shared.mkdir(mode=0o755)
            with self.assertRaises(PermissionError):
                ensure_private_directory(shared)
            self.assertEqual(shared.stat().st_mode & 0o777, 0o755)
            linked = root / "linked"
            linked.symlink_to(root / "target")
            with self.assertRaises(OSError):
                secure_open(linked, os.O_CREAT | os.O_RDWR)
            self.assertFalse((root / "target").exists())


if __name__ == "__main__":
    unittest.main()
