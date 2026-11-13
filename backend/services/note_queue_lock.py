"""Process ownership of a local vault queue; the OS releases locks on exit."""

import os


class QueueProcessLock:
    def __init__(self, path):
        if path.is_symlink():
            raise OSError("Unsafe queue lock path")
        self._file = open(path, "a+b")
        try:
            self._file.seek(0, os.SEEK_END)
            if self._file.tell() == 0:
                self._file.write(b"0")
                self._file.flush()
            self._file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            self._file.close()
            raise

    def close(self):
        if self._file.closed:
            return
        try:
            self._file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._file, fcntl.LOCK_UN)
        finally:
            self._file.close()
