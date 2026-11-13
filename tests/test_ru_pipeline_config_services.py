"""Independent configuration and lifetime tests; no neural model is loaded."""

from copy import deepcopy
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

from backend.note_processing_failures import NoteSystemError
from backend.ru_pipeline import config
from backend.ru_pipeline.services import LocalServices


@pytest.fixture(autouse=True)
def clean_ru_environment(monkeypatch):
    for name in (
        "NODA_RU_PIPELINE_ENABLED",
        "NODA_RU_TAG_DESCRIPTIONS",
        "NODA_RU_MMARCO_PYTHON",
        "NODA_RU_TEV_PYTHON",
    ):
        monkeypatch.delenv(name, raising=False)


def local_config(tmp_path, **overrides):
    return config.PipelineConfig(
        repo_root=tmp_path, runtime_dir=tmp_path / "runtime", **overrides
    )


def install_scorer(monkeypatch, operation):
    module = ModuleType("backend.ru_pipeline.scorers")
    module.score_pairs = operation
    monkeypatch.setitem(sys.modules, module.__name__, module)


def install_native(monkeypatch, operation):
    module = ModuleType("backend.ru_pipeline.native")
    module.NativeSession = operation
    monkeypatch.setitem(sys.modules, module.__name__, module)


def pairs(count):
    return [
        {"source": "Полный исходник\r\nс хвостом  ", "target": f"target-{n}"}
        for n in range(count)
    ]


def test_default_config_is_local_and_has_no_invented_descriptions(tmp_path):
    value = local_config(tmp_path)
    assert value.project_root == value.repo_root == tmp_path.resolve()
    assert value.port == 19189
    assert value.mmarco_python.is_absolute() and value.tev_python.is_absolute()
    assert value.mmarco_python.is_relative_to(tmp_path)
    assert (
        value.mmarco_assets
        == tmp_path / "backend/ru_pipeline/assets/scorer_mmarco.json"
    )
    assert not value.runtime_dir.exists()
    assert dict(value.tag_descriptions) == {}
    assert "output" not in value.mmarco_python.parts


def test_description_mapping_is_copied_and_immutable(tmp_path):
    source = {"наука": "Точная пользовательская формулировка", "дом": ""}
    value = local_config(tmp_path, tag_descriptions=source)
    source["наука"] = "changed"
    assert value.tag_descriptions["наука"] == "Точная пользовательская формулировка"
    assert value.tag_descriptions["дом"] == ""
    with pytest.raises(TypeError):
        value.tag_descriptions["new"] = "no"


@pytest.mark.parametrize(
    "raw,expected", [("1", True), ("0", False), (" TRUE ", True), ("false", False)]
)
def test_enabled_explicit_environment_values(monkeypatch, raw, expected):
    monkeypatch.setenv("NODA_RU_PIPELINE_ENABLED", raw)
    assert config.enabled() is expected


@pytest.mark.parametrize("raw", ["", "yes", "2", "none"])
def test_enabled_rejects_ambiguous_environment(monkeypatch, raw):
    monkeypatch.setenv("NODA_RU_PIPELINE_ENABLED", raw)
    with pytest.raises(ValueError):
        config.enabled()


def test_runtime_boolean_overrides_environment(monkeypatch):
    monkeypatch.setenv("NODA_RU_PIPELINE_ENABLED", "0")
    assert config.enabled(SimpleNamespace(RU_NOTE_PIPELINE_ENABLED=True)) is True
    assert config.enabled(SimpleNamespace(RU_NOTE_PIPELINE_ENABLED=False)) is False


@pytest.mark.parametrize("raw", [1, "true", [], {}])
def test_runtime_flag_requires_boolean(raw):
    with pytest.raises(ValueError):
        config.enabled(SimpleNamespace(RU_NOTE_PIPELINE_ENABLED=raw))


@pytest.mark.parametrize("port", [True, 1023, 65536, "19189"])
def test_port_validation(tmp_path, port):
    with pytest.raises(ValueError):
        local_config(tmp_path, port=port)


@pytest.mark.parametrize("port", [1024, 65535])
def test_port_valid_boundaries(tmp_path, port):
    assert local_config(tmp_path, port=port).port == port


@pytest.mark.parametrize(
    "field",
    [
        "scorer_timeout",
        "native_startup_timeout",
        "native_stop_timeout",
        "native_request_timeout",
        "lock_timeout",
    ],
)
@pytest.mark.parametrize("value", [True, 0, -1, float("nan"), float("inf"), 3601])
def test_timeouts_are_finite_positive_and_bounded(tmp_path, field, value):
    with pytest.raises(ValueError):
        local_config(tmp_path, **{field: value})


@pytest.mark.parametrize(
    "descriptions",
    [
        {"": "x"},
        {"x" * 81: "x"},
        {"x": 1},
        {"x": "y" * 2001},
        {"x": "\x00"},
        {"bad\x00": "x"},
    ],
)
def test_invalid_descriptions_rejected(tmp_path, descriptions):
    with pytest.raises(ValueError):
        local_config(tmp_path, tag_descriptions=descriptions)


def test_config_normalizes_relative_paths_without_reading_or_creating_them(tmp_path):
    value = local_config(tmp_path, mmarco_python=Path("env/python.exe"))
    assert value.mmarco_python == tmp_path / "env/python.exe"
    assert not value.mmarco_python.exists()


def test_get_config_preserves_trusted_instance_and_rejects_untyped_override(tmp_path):
    trusted = local_config(tmp_path)
    assert config.get_config(SimpleNamespace(ru_pipeline_config=trusted)) is trusted
    with pytest.raises(ValueError):
        config.get_config(SimpleNamespace(ru_pipeline_config={"port": 19189}))


def test_default_get_config_needs_no_optional_descriptions():
    value = config.get_config()
    assert config.enabled() is True
    assert dict(value.tag_descriptions) == {}
    assert value.repo_root == config.ROOT


def test_optional_descriptions_and_worker_overrides(monkeypatch, tmp_path):
    descriptions = tmp_path / "descriptions.json"
    descriptions.write_text(
        json.dumps({"наука": "Измерения"}, ensure_ascii=False), encoding="utf-8"
    )
    monkeypatch.setenv("NODA_RU_TAG_DESCRIPTIONS", str(descriptions))
    monkeypatch.setenv("NODA_RU_MMARCO_PYTHON", str(tmp_path / "ort/python.exe"))
    monkeypatch.setenv("NODA_RU_TEV_PYTHON", str(tmp_path / "torch/python.exe"))
    value = config.get_config()
    assert dict(value.tag_descriptions) == {"наука": "Измерения"}
    assert value.mmarco_python == tmp_path / "ort/python.exe"
    assert value.tev_python == tmp_path / "torch/python.exe"


@pytest.mark.parametrize("text", ["[]", "null", '"text"', "{bad"])
def test_description_file_requires_json_mapping(monkeypatch, tmp_path, text):
    path = tmp_path / "description.json"
    path.write_text(text, encoding="utf-8")
    monkeypatch.setenv("NODA_RU_TAG_DESCRIPTIONS", str(path))
    with pytest.raises(ValueError):
        config.get_config()


def test_description_file_size_limit(monkeypatch, tmp_path):
    path = tmp_path / "description.json"
    path.write_bytes(b" " * (1024 * 1024 + 1))
    monkeypatch.setenv("NODA_RU_TAG_DESCRIPTIONS", str(path))
    with pytest.raises(ValueError):
        config.get_config()


def test_duplicate_description_key_is_rejected(monkeypatch, tmp_path):
    path = tmp_path / "duplicate.json"
    path.write_text('{"тег":"первое","тег":"второе"}', encoding="utf-8")
    monkeypatch.setenv("NODA_RU_TAG_DESCRIPTIONS", str(path))
    with pytest.raises(ValueError):
        config.get_config()


def test_lease_is_required_for_generator_and_scorer(tmp_path):
    services = LocalServices(local_config(tmp_path))
    with pytest.raises(NoteSystemError) as error:
        services.score("mmarco", [])
    assert error.value.failure_code == "ru_runtime_lease_missing"
    with pytest.raises(NoteSystemError):
        with services.generator("qwen25_3b"):
            pytest.fail("Must not reach an inactive provider")


def test_real_filelock_excludes_second_job_and_releases_after_failure(tmp_path):
    value = local_config(tmp_path, lock_timeout=0.02)
    with pytest.raises(RuntimeError, match="synthetic"):
        with LocalServices(value):
            with pytest.raises(NoteSystemError) as error:
                with LocalServices(value):
                    pytest.fail("A second job acquired the active lease")
            assert error.value.failure_code == "ru_runtime_busy"
            raise RuntimeError("synthetic job failure")
    with LocalServices(value) as third:
        assert third is not None


def test_same_instance_nested_entry_cannot_release_the_outer_lease(tmp_path):
    value = local_config(tmp_path, lock_timeout=0.02)
    services = LocalServices(value)
    with services:
        with pytest.raises(NoteSystemError):
            services.__enter__()
        with pytest.raises(NoteSystemError):
            with LocalServices(value):
                pytest.fail("The outer lease was lost after nested entry")
    with LocalServices(value):
        pass


def test_runtime_directory_cannot_be_a_file(tmp_path):
    folder = tmp_path / "occupied"
    folder.write_text("preserve", encoding="utf-8")
    with pytest.raises(NoteSystemError):
        with LocalServices(
            config.PipelineConfig(repo_root=tmp_path, runtime_dir=folder)
        ):
            pytest.fail("An existing file cannot be the runtime directory")
    assert folder.read_text(encoding="utf-8") == "preserve"


def test_generator_closes_before_scoring_and_never_overlaps(monkeypatch, tmp_path):
    events = []

    class Native:
        def __init__(self, model, value):
            self.model = model

        def __enter__(self):
            events.append(("start", self.model))
            return self

        def __exit__(self, *args):
            events.append(("close", self.model))

    install_native(monkeypatch, Native)
    install_scorer(
        monkeypatch,
        lambda engine, page, value: events.append(("score", engine))
        or [0.75] * len(page),
    )
    with LocalServices(local_config(tmp_path)) as services:
        with services.generator("qwen25_3b"):
            with pytest.raises(NoteSystemError):
                with services.generator("qwen35_4b"):
                    pytest.fail("Generators overlapped")
            with pytest.raises(NoteSystemError):
                services.score("mmarco", pairs(1))
        assert services.score("mmarco", pairs(1)) == [0.75]
    assert events == [
        ("start", "qwen25_3b"),
        ("close", "qwen25_3b"),
        ("score", "mmarco"),
    ]


def test_failed_native_entry_resets_lifetime_and_releases_job(monkeypatch, tmp_path):
    class FailedNative:
        def __init__(self, model, value):
            pass

        def __enter__(self):
            raise NoteSystemError("Synthetic startup failure")

        def __exit__(self, *args):
            pytest.fail("A failed context entry must not be exited")

    install_native(monkeypatch, FailedNative)
    install_scorer(monkeypatch, lambda engine, page, value: [0.5] * len(page))
    value = local_config(tmp_path)
    with LocalServices(value) as services:
        with pytest.raises(NoteSystemError):
            with services.generator("qwen25_3b"):
                pytest.fail("Startup failure was hidden")
        assert services.score("mmarco", pairs(1)) == [0.5]
    with LocalServices(value):
        pass


def test_more_than_128_scores_preserve_every_pair_and_original_order(
    monkeypatch, tmp_path
):
    requests = []

    def score(engine, page, value):
        requests.append(deepcopy(page))
        return [float(row["target"].split("-")[1]) for row in page]

    install_scorer(monkeypatch, score)
    source = pairs(275)
    before = deepcopy(source)
    with LocalServices(local_config(tmp_path)) as services:
        assert services.score("mmarco", source) == list(map(float, range(275)))
    assert [len(page) for page in requests] == [128, 128, 19]
    assert [row for page in requests for row in page] == before == source


def test_empty_valid_score_input_does_not_load_worker(monkeypatch, tmp_path):
    def forbidden(*args):
        pytest.fail("Empty input must not load a neural worker")

    install_scorer(monkeypatch, forbidden)
    with LocalServices(local_config(tmp_path)) as services:
        assert services.score("mmarco", []) == []


def test_incomplete_or_failed_page_never_becomes_partial_success(monkeypatch, tmp_path):
    counter = 0

    def score(engine, page, value):
        nonlocal counter
        counter += 1
        return [0.2] * (len(page) if counter == 1 else len(page) - 1)

    install_scorer(monkeypatch, score)
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score("mmarco", pairs(129))
    assert counter == 2


def test_worker_failure_on_second_page_preserves_error_and_releases_job(
    monkeypatch, tmp_path
):
    counter = 0

    def score(engine, page, value):
        nonlocal counter
        counter += 1
        if counter == 2:
            raise NoteSystemError(
                "Synthetic unavailable worker", failure_code="synthetic_worker_failure"
            )
        return [0.5] * len(page)

    install_scorer(monkeypatch, score)
    value = local_config(tmp_path)
    with pytest.raises(NoteSystemError) as error:
        with LocalServices(value) as services:
            services.score("mmarco", pairs(129))
    assert counter == 2 and error.value.failure_code == "synthetic_worker_failure"
    with LocalServices(value):
        pass


@pytest.mark.parametrize("invalid", [None, (), {}, "pair"])
def test_non_list_score_input_is_typed_failure(monkeypatch, tmp_path, invalid):
    install_scorer(
        monkeypatch, lambda *args: pytest.fail("Invalid input reached worker")
    )
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score("mmarco", invalid)


@pytest.mark.parametrize(
    "value",
    [
        [float("nan")],
        [float("inf")],
        [float("-inf")],
        [True],
        ["0.5"],
        "x",
        {"x": 0.5},
        0.5,
    ],
)
def test_scorer_boundary_rejects_nonfinite_or_non_numeric_lists(
    monkeypatch, tmp_path, value
):
    install_scorer(monkeypatch, lambda *args: value)
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score("mmarco", pairs(1))


def test_unknown_engine_is_rejected_even_when_input_empty(monkeypatch, tmp_path):
    install_scorer(monkeypatch, lambda *args: [])
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score("remote-or-unknown", [])


def test_unhashable_engine_is_typed_failure(monkeypatch, tmp_path):
    install_scorer(
        monkeypatch, lambda *args: pytest.fail("Invalid engine reached worker")
    )
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score([], [])


def test_oversized_integer_score_cannot_escape_as_overflow(monkeypatch, tmp_path):
    install_scorer(monkeypatch, lambda *args: [10**10000])
    with LocalServices(local_config(tmp_path)) as services:
        with pytest.raises(NoteSystemError):
            services.score("mmarco", pairs(1))


@pytest.mark.parametrize("length", [1001, 2000])
def test_tag_description_cannot_exceed_stage_transport_limit(length):
    from backend.ru_pipeline.config import PipelineConfig

    with pytest.raises(ValueError, match="descriptions"):
        PipelineConfig(tag_descriptions={"ремонт": "д" * length})


def test_tag_description_at_stage_limit_is_valid():
    from backend.ru_pipeline.config import PipelineConfig

    config = PipelineConfig(tag_descriptions={"ремонт": "д" * 1000})
    assert config.tag_descriptions["ремонт"] == "д" * 1000
