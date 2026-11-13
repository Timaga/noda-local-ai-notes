"""Exclusive access to one existing Windows note, without path replacement."""

from contextlib import contextmanager
import os
from pathlib import Path
import stat


MAX_BYTES = 524288
_CODES = frozenset(("target_busy", "target_changed", "unsupported", "io_error"))


class LocalNoteFileError(RuntimeError):
    def __init__(self, code):
        if code not in _CODES:
            raise ValueError("Unknown local note file error")
        self.code = code
        super().__init__(code)


def _checked_stat(info):
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or not info.st_ino
        or bool(getattr(info, "st_file_attributes", 0) & 0x400)
    ):
        raise LocalNoteFileError("target_changed")
    return info


def _close_fd(descriptor):
    try:
        os.close(descriptor)
    except OSError:
        raise LocalNoteFileError("io_error") from None


def _open_fd(path):
    import ctypes
    from ctypes import wintypes
    import msvcrt

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL
    handle = create(str(path), 0xC0000000, 0, None, 3, 0x00200080, None)
    if handle == ctypes.c_void_p(-1).value:
        code = ctypes.get_last_error()
        if code in (32, 33):
            raise LocalNoteFileError("target_busy")
        raise LocalNoteFileError("target_changed" if code in (2, 3) else "io_error")
    try:
        descriptor = msvcrt.open_osfhandle(
            handle, os.O_RDWR | os.O_BINARY | os.O_NOINHERIT
        )
    except BaseException:
        if not close(handle):
            raise LocalNoteFileError("io_error") from None
        raise
    return descriptor


class _LockedNote:
    def __init__(self, path, descriptor, max_bytes):
        self._path, self._descriptor, self._max_bytes = path, descriptor, max_bytes
        self._identity = None
        initial = self.snapshot()
        self._identity = initial["identity"]

    def snapshot(self):
        if self._descriptor is None:
            raise LocalNoteFileError("io_error")
        try:
            info = _checked_stat(os.fstat(self._descriptor))
            current = _checked_stat(self._path.lstat())
            identity = [info.st_dev, info.st_ino]
            if (
                identity != [current.st_dev, current.st_ino]
                or self._identity is not None
                and identity != self._identity
                or info.st_size > self._max_bytes
            ):
                raise LocalNoteFileError("target_changed")
            return {
                "identity": identity,
                "size": info.st_size,
                "mtime_ns": info.st_mtime_ns,
            }
        except OSError:
            raise LocalNoteFileError("io_error") from None

    def read_all(self):
        self.snapshot()
        try:
            os.lseek(self._descriptor, 0, os.SEEK_SET)
            chunks, length = [], 0
            while True:
                chunk = os.read(
                    self._descriptor, min(65536, self._max_bytes + 1 - length)
                )
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length > self._max_bytes:
                    raise LocalNoteFileError("target_changed")
            return b"".join(chunks)
        except OSError:
            raise LocalNoteFileError("io_error") from None

    def write_all(self, data):
        if type(data) is not bytes or not 0 < len(data) <= self._max_bytes:
            raise LocalNoteFileError("io_error")
        self.snapshot()
        try:
            os.lseek(self._descriptor, 0, os.SEEK_SET)
            position = 0
            while position < len(data):
                count = os.write(self._descriptor, data[position:])
                if not 0 < count <= len(data) - position:
                    raise LocalNoteFileError("io_error")
                position += count
            os.ftruncate(self._descriptor, len(data))
            os.fsync(self._descriptor)
            if self.read_all() != data:
                raise LocalNoteFileError("io_error")
        except OSError:
            raise LocalNoteFileError("io_error") from None

    def close(self):
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is not None:
            _close_fd(descriptor)


@contextmanager
def locked_note(path, *, max_bytes=MAX_BYTES):
    if os.name != "nt":
        raise LocalNoteFileError("unsupported")
    if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
        raise LocalNoteFileError("io_error")
    descriptor = None
    try:
        path = Path(path)
        if not path.is_absolute():
            raise LocalNoteFileError("target_changed")
        _checked_stat(path.lstat())
        descriptor = _open_fd(path)
        note = _LockedNote(path, descriptor, max_bytes)
        descriptor = None
    except LocalNoteFileError:
        raise
    except FileNotFoundError:
        raise LocalNoteFileError("target_changed") from None
    except (OSError, ValueError, TypeError):
        raise LocalNoteFileError("io_error") from None
    finally:
        if descriptor is not None:
            _close_fd(descriptor)
    try:
        yield note
    finally:
        note.close()
