"""Platform storage and Windows transport authentication without a live browser."""
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from backend_native import bridge
from platform_support import ensure_private_directory, secure_open, assert_private_file, lock_file


class TransportAuthenticationTests(unittest.TestCase):
    def authenticate(self, client_nonce="a" * 64, valid=True):
        server, client = socket.socketpair()
        server.settimeout(2)
        client.settimeout(2)
        host = bridge.Bridge(Path(tempfile.gettempdir()) / "unused", stdout=io.BytesIO())
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
    def test_regular_private_file_and_two_independent_lock_handles(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory).resolve() / "private"
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
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "private"
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
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "private"
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
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
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
