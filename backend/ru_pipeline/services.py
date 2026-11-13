"""Serialized local model lifetimes for the three-stage Russian note method."""

from contextlib import contextmanager
import math
from pathlib import Path
import stat

from filelock import FileLock, Timeout

from .scorer_contract import engine_parts

try:
    from backend.note_processing_failures import NoteSystemError
except ImportError:
    from note_processing_failures import NoteSystemError


def _runtime_folder(folder):
    folder = Path(folder).absolute()
    for path in (folder, *folder.parents):
        if not path.exists():
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise NoteSystemError(
                "Каталог локального конвейера не должен быть ссылкой.",
                failure_code="ru_runtime_path_invalid",
            )
    folder.mkdir(parents=True, exist_ok=True)
    return folder


class LocalServices:
    """One full job owns the local GPU lease; scorer batches have no semantic cap."""

    SCORE_PAGE = 128

    def __init__(self, config):
        self.config = config
        self._lock = None
        self._generator_active = False
        self.link_score_diagnostics = {}

    def __enter__(self):
        if self._lock is not None:
            raise NoteSystemError(
                "Локальный сеанс уже открыт.", failure_code="ru_runtime_overlap"
            )
        try:
            folder = _runtime_folder(self.config.runtime_dir)
            self._lock = FileLock(
                str(folder / "models.lock"), timeout=self.config.lock_timeout
            )
            self._lock.acquire()
        except Timeout as exc:
            self._lock = None
            raise NoteSystemError(
                "Локальный русский конвейер занят другим заданием.",
                failure_code="ru_runtime_busy",
            ) from exc
        except OSError as exc:
            self._lock = None
            raise NoteSystemError(
                "Не удалось открыть каталог локального конвейера.",
                failure_code="ru_runtime_path_unavailable",
            ) from exc
        return self

    def __exit__(self, *args):
        if self._lock is not None:
            self._lock.release()
            self._lock = None

    def _require_lease(self):
        if self._lock is None or not self._lock.is_locked:
            raise NoteSystemError(
                "Для моделей нужен активный локальный сеанс.",
                failure_code="ru_runtime_lease_missing",
            )

    @contextmanager
    def generator(self, model_key):
        self._require_lease()
        if self._generator_active:
            raise NoteSystemError(
                "Генераторы должны работать последовательно.",
                failure_code="ru_runtime_overlap",
            )
        try:
            from backend.ru_pipeline.native import NativeSession
        except ImportError:
            from ru_pipeline.native import NativeSession
        self._generator_active = True
        try:
            with NativeSession(model_key, self.config) as provider:
                yield provider
        finally:
            self._generator_active = False

    def score(self, engine, pairs):
        self._require_lease()
        if engine_parts(engine)[0] is None:
            raise NoteSystemError(
                "Неизвестный локальный оценщик.",
                failure_code="ru_scorer_engine_invalid",
            )
        if type(pairs) is not list:
            raise NoteSystemError(
                "Оценщику нужен список полных пар.",
                failure_code="ru_scorer_input_invalid",
            )
        if self._generator_active:
            raise NoteSystemError(
                "Оценка начинается после выгрузки генератора.",
                failure_code="ru_runtime_overlap",
            )
        try:
            from backend.ru_pipeline.scorers import score_pairs
        except ImportError:
            from ru_pipeline.scorers import score_pairs
        result = []
        for offset in range(0, len(pairs), self.SCORE_PAGE):
            page = pairs[offset : offset + self.SCORE_PAGE]
            scores = score_pairs(engine, page, self.config)
            if (
                type(scores) is not list
                or len(scores) != len(page)
                or any(not _finite(value) for value in scores)
            ):
                raise NoteSystemError(
                    "Оценщик вернул неполный набор результатов.",
                    failure_code="ru_scorer_incomplete",
                )
            result.extend(scores)
        return result

    def score_links(self, engine, pairs):
        self._require_lease()
        if engine != "mmarco":
            self.link_score_diagnostics = {"scoring_transport_version": "full-pairs-v1"}
            return self.score(engine, pairs)
        from backend.ru_pipeline.link_scoring import TRANSPORT, score_links

        scores, diagnostics = score_links(self.score, pairs, self.config)
        self.link_score_diagnostics = {
            "scoring_transport_version": TRANSPORT,
            **diagnostics,
        }
        return scores


def _finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False
