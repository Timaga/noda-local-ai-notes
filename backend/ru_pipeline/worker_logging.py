"""Suppress dependency/native output while preserving the worker JSON channel."""

from contextlib import contextmanager
import os
import sys


@contextmanager
def muted_dependencies():
    saved = []
    with open(os.devnull, "wb") as sink:
        try:
            for stream in (sys.stdout, sys.stderr):
                stream.flush()
            descriptors = {1, 2, sys.stdout.fileno(), sys.stderr.fileno()}
            for descriptor in sorted(descriptors):
                saved.append((descriptor, os.dup(descriptor)))
                os.dup2(sink.fileno(), descriptor)
            yield
        finally:
            for stream in (sys.stdout, sys.stderr):
                stream.flush()
            for descriptor, duplicate in reversed(saved):
                os.dup2(duplicate, descriptor)
                os.close(duplicate)
