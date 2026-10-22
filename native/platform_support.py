"""Private local storage and nonblocking document locks on POSIX and Windows.

Windows requires pywin32. Security checks fail closed when unavailable; chmod
and synthetic Unix uid values are never treated as Windows access control.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
from functools import wraps

WINDOWS = os.name == "nt"
if WINDOWS:
    import msvcrt
    import pywintypes
    import win32api
    import win32con
    import win32file
    import win32security
    from win32com.shell import shell, shellcon
else:
    import fcntl


def _windows_errors(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception as exc:
            if WINDOWS and isinstance(exc, pywintypes.error):
                raise OSError(exc.winerror, "Windows private storage operation failed") from exc
            raise
    return wrapped


def _sid():
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()


def _sid_text(value):
    return win32security.ConvertSidToStringSid(value)


def _attributes():
    acl = win32security.ACL()
    for principal in (_sid(), win32security.ConvertStringSidToSid("S-1-5-18"), win32security.ConvertStringSidToSid("S-1-5-32-544")):
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE, win32con.GENERIC_ALL, principal)
    descriptor = win32security.SECURITY_DESCRIPTOR()
    descriptor.SetSecurityDescriptorOwner(_sid(), False)
    descriptor.SetSecurityDescriptorDacl(1, acl, 0)
    descriptor.SetSecurityDescriptorControl(win32security.SE_DACL_PROTECTED, win32security.SE_DACL_PROTECTED)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = descriptor
    return attributes


def _windows_path(path):
    raw_parts = str(path).replace("\\", "/").split("/")
    if any(part in (".", "..") or part.endswith((".", " ")) for part in raw_parts if part):
        raise PermissionError("Windows private storage cannot use relative or aliased path components")
    if any(":" in part for part in raw_parts[1:]):
        raise PermissionError("Windows alternate data streams are not private storage paths")
    path = Path(path)
    if not path.is_absolute() or str(path).startswith("\\\\"):
        raise PermissionError("Private storage requires an absolute local path")
    # The trusted user profile is supplied by Windows, not by a caller's HOME.
    home = Path(shell.SHGetFolderPath(0, shellcon.CSIDL_PROFILE, None, 0))
    try:
        relative = path.relative_to(home)
    except ValueError as exc:
        raise PermissionError("Windows private storage must be inside the current user's profile") from exc
    return path, [home, *[home.joinpath(*relative.parts[:index]) for index in range(1, len(relative.parts) + 1)]]


def _windows_check(path, *, private=False, directory=False, owned=True, creating=False):
    info = Path(path).lstat()
    if getattr(info, "st_file_attributes", 0) & win32con.FILE_ATTRIBUTE_REPARSE_POINT:
        raise PermissionError("Reparse points are not permitted in private storage")
    if directory and not stat.S_ISDIR(info.st_mode):
        raise PermissionError("Private directory must be a real directory")
    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise PermissionError("Private file must be regular with a single link")
    descriptor = win32security.GetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT, win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION)
    owner = _sid_text(descriptor.GetSecurityDescriptorOwner())
    current = _sid_text(_sid())
    trusted = {current, "S-1-5-18", "S-1-5-32-544"}
    if owner not in ({current} if owned else trusted):
        raise PermissionError("Private storage has an unexpected owner")
    acl = descriptor.GetSecurityDescriptorDacl()
    if acl is None:
        raise PermissionError("An unrestricted Windows DACL is not private")
    # For existing ancestors, creating another child does not allow replacing
    # an existing protected child. Deleting children / changing ACLs does.
    dangerous = 0x40000000 | 0x10000000 | 0x00040000 | 0x00080000 | 0x00010000 | 0x00000040 | 0x00000002
    if creating:
        dangerous |= 0x00000004  # Foreign FILE_ADD_SUBDIRECTORY can race creation.
    for index in range(acl.GetAceCount()):
        ace = acl.GetAce(index)
        kind, flags = ace[0]
        if flags & win32con.INHERIT_ONLY_ACE or kind in (win32security.ACCESS_DENIED_ACE_TYPE, win32security.ACCESS_DENIED_OBJECT_ACE_TYPE):
            continue
        if kind != win32security.ACCESS_ALLOWED_ACE_TYPE:
            raise PermissionError("Unsupported Windows ACL entry")
        if _sid_text(ace[2]) not in trusted and (private or ace[1] & dangerous):
            raise PermissionError("Windows private storage grants access to another principal")
    return info


def _windows_ancestors(path, *, create=False):
    path, chain = _windows_path(path)
    for directory in chain:
        try:
            _windows_check(directory, directory=True, owned=False)
        except FileNotFoundError:
            if not create:
                raise
            # A read-only ancestor is safe, but no other principal may create
            # children here and race creation of our protected directory.
            _windows_check(directory.parent, directory=True, owned=False, creating=True)
            try:
                win32file.CreateDirectory(str(directory), _attributes())
            except pywintypes.error as exc:
                # Another native worker may create the same protected parent
                # after our check. Only already-exists is benign, and only
                # after the same complete private/type/reparse validation.
                if exc.winerror != 183:  # ERROR_ALREADY_EXISTS
                    raise
            _windows_check(directory, private=True, directory=True)
    return path


@_windows_errors
def ensure_private_directory(path):
    path = Path(path)
    if WINDOWS:
        _windows_ancestors(path, create=True)
        _windows_check(path, private=True, directory=True, owned=False)
        return path
    if not path.is_absolute():
        raise PermissionError("Private path must be absolute")
    for directory in [*reversed(path.parents), path]:
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
        info = directory.lstat()
        sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not sticky_root):
            raise PermissionError("Private storage ancestors must be trusted, non-symlink directories")
    info = path.lstat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise PermissionError("Private directory must be owned and mode 0700")
    return path


@_windows_errors
def assert_owned_file(path):
    path = Path(path)
    if WINDOWS:
        _windows_path(path)
        _windows_ancestors(path.parent)
        return _windows_check(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise PermissionError("File must be owned, regular and have a single link")
    return info


@_windows_errors
def assert_private_file(path):
    if WINDOWS:
        _windows_path(path)
        _windows_ancestors(Path(path).parent)
        return _windows_check(path, private=True)
    info = assert_owned_file(path)
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise PermissionError("Private file must have mode 0600")
    return info


@_windows_errors
def protect_file(path):
    """Set private permissions on a newly created owned file, before its bytes.

    Callers must not use this to repair an untrusted pre-existing private file.
    """
    assert_owned_file(path)
    if WINDOWS:
        win32security.SetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT,
            win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            None, None, _attributes().SECURITY_DESCRIPTOR.GetSecurityDescriptorDacl(), None)
    else:
        os.chmod(path, 0o600, follow_symlinks=False)
    assert_private_file(path)


@_windows_errors
def secure_open(path, flags, mode=0o600):
    """Open/create a private regular file without following links."""
    path = Path(path)
    if not WINDOWS:
        return os.open(path, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode)
    _windows_path(path)
    _windows_ancestors(path.parent)
    _windows_check(path.parent, private=True, directory=True, owned=False)
    creation = win32con.CREATE_NEW if flags & os.O_EXCL else win32con.OPEN_ALWAYS if flags & os.O_CREAT else win32con.OPEN_EXISTING
    access = win32con.GENERIC_READ
    if flags & (os.O_WRONLY | os.O_RDWR):
        access |= win32con.GENERIC_WRITE
    handle = win32file.CreateFile(str(path), access, win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
        _attributes(), creation, win32file.FILE_FLAG_OPEN_REPARSE_POINT, None)
    try:
        assert_private_file(path)
        # Access rights are already set on the native handle. The CRT adapter
        # accepts append/binary/inheritance flags, not CreateFile access bits.
        file_flags = os.O_BINARY | os.O_NOINHERIT
        if flags & os.O_APPEND:
            file_flags |= os.O_APPEND
        raw_handle = handle.Detach()
        handle = None
        try:
            return msvcrt.open_osfhandle(raw_handle, file_flags)
        except BaseException:
            win32api.CloseHandle(raw_handle)
            raise
    finally:
        if handle is not None:
            handle.Close()


@_windows_errors
def lock_file(fd):
    if WINDOWS:
        # LockFileEx locks a byte range even in an empty file. Locks are bound to
        # this handle, so two coordinators in one process still conflict.
        try:
            win32file.LockFileEx(msvcrt.get_osfhandle(fd), win32con.LOCKFILE_EXCLUSIVE_LOCK | win32con.LOCKFILE_FAIL_IMMEDIATELY, 1, 0, pywintypes.OVERLAPPED())
        except pywintypes.error as exc:
            if exc.winerror in (32, 33):
                raise BlockingIOError("Document lock is already held") from exc
            raise
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def ensure_private_file(path, *, exclusive=False):
    flags = os.O_CREAT | os.O_RDWR | (os.O_EXCL if exclusive else 0)
    fd = secure_open(path, flags)
    try:
        assert_private_file(path)
    finally:
        os.close(fd)


def create_private_file(path):
    return ensure_private_file(path, exclusive=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ensure-directory", "verify-file", "protect-file", "owned-file", "create-file", "ensure-file"))
    parser.add_argument("path")
    args = parser.parse_args()
    actions = {"ensure-directory": ensure_private_directory, "verify-file": assert_private_file, "protect-file": protect_file, "owned-file": assert_owned_file, "create-file": create_private_file, "ensure-file": ensure_private_file}
    actions[args.command](args.path)
    print(json.dumps({"ok": True, "path": str(Path(args.path))}))


if __name__ == "__main__":
    main()
