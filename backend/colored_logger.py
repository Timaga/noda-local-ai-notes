"""
Colored logging module with [ERROR], [WARN], [INFO] prefixes.

This module provides colored logging functionality using colorlog library.
"""

import logging
import sys

try:
    import colorlog
    COLORLOG_AVAILABLE = True
except ImportError:
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Preserve a module-level colorlog attribute when the optional dependency is missing
    #       so tests and monkeypatch-based callers can inject a formatter without ImportError state leaks.
    colorlog = None
    COLORLOG_AVAILABLE = False


def setup_colored_logger(name=None, level=logging.INFO):
    """
    Setup a colored logger with prefixed format.

    Args:
        name: Logger name (if None, returns root logger)
        level: Logging level (default: INFO)

    Returns:
        Configured logger instance
    """
    logger = logging.getLogger(name)

    # Avoid duplicate handlers
    if logger.handlers:
        return logger

    logger.setLevel(level)

    if COLORLOG_AVAILABLE:
        # Colored formatter with prefixes
        formatter = colorlog.ColoredFormatter(
            '%(log_color)s[%(levelname)s]%(reset)s %(message)s',
            log_colors={
                'DEBUG': 'cyan',
                'INFO': 'green',
                'WARNING': 'yellow',
                'ERROR': 'red',
                'CRITICAL': 'red,bg_white',
            },
            reset=True,
            style='%'
        )
    else:
        # Fallback to standard formatter if colorlog is not available
        formatter = logging.Formatter('[%(levelname)s] %(message)s')

    # Console handler
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    logger.addHandler(handler)

    return logger


def get_logger(name=None):
    """
    Get or create a colored logger.

    Args:
        name: Logger name (if None, returns root logger)

    Returns:
        Configured logger instance
    """
    return setup_colored_logger(name)
