"""Lossless Russian pipeline metadata and legacy wrapper compatibility."""

import hashlib
import json
import ast
from pathlib import Path
import threading

import pytest

from backend.note_faithful_archive import (
    ArchiveRecord,
    assert_unchanged,
    current_wrapper_metadata,
    snapshot_archive,
    unwrap_source,
    wrapper_metadata,
)
from backend.note_generation_contract import (
    NoteGenerationError,
    extract_note_links,
    extract_note_tags,
)
from backend.note_service_card import extract_service_card, parse_frontmatter
from backend.note_disk_source import load_note_cache


def wrapper(source, *, tags=(), links=(), version="ru-pipeline-v1", newline="\n"):
    values = {
        "title": "Полный исходник без изменений",
        "tags": list(tags),
        "related": list(links),
        "noda_source_version": version,
        "noda_source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "noda_source_length": len(source),
    }
    header = ["---"] + [
        key + ": " + json.dumps(value, ensure_ascii=False)
        for key, value in values.items()
    ]
    return newline.join(header + ["---", ""]) + source


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_new_wrapper_retains_all_metadata_and_exact_source(newline):
    source = "\ufeff  Авторский текст\r\n\t#не_из_каталога [[Не выбрана]]  \r\n"
    tags = [f"каталог_{index}" for index in range(25)]
    links = [f"папка/Заметка {index}" for index in range(65)]
    disk = wrapper(source, tags=tags, links=links, newline=newline)

    metadata, body = wrapper_metadata(disk)
    assert body == source
    assert metadata["noda_source_version"] == "ru-pipeline-v1"
    assert metadata["tags"] == tags
    assert metadata["related"] == links
    assert unwrap_source(disk) == source
    assert parse_frontmatter(disk)[1] == source
    assert extract_note_tags(disk) == tags
    assert extract_note_links(disk) == links
    card = extract_service_card("Имя файла", disk)
    assert card["body"] == source
    assert card["tags"] == tags
    assert card["related"] == links
    assert extract_service_card("Имя файла", disk, tags=tags)["tags"] == tags
    assert extract_service_card("Имя файла", disk, tags=["подмена"])["tags"] == tags


def test_empty_selected_metadata_does_not_adopt_unknown_body_tags_or_links():
    source = "Исходник #новый_тег [[Несуществующая]]"
    disk = wrapper(source)
    assert unwrap_source(disk) == source
    assert extract_note_tags(disk) == []
    assert extract_note_links(disk) == []


@pytest.mark.parametrize("field", ["tags", "related"])
@pytest.mark.parametrize(
    "invalid",
    [
        None,
        "тег",
        [1],
        [[]],
        [""],
        [" "],
        [" тег"],
        ["тег\x00"],
        ["тег\n"],
        ["тег", "тег"],
    ],
)
def test_new_wrapper_rejects_invalid_metadata_without_silently_fixing(field, invalid):
    disk = wrapper("Полный исходник")
    disk = disk.replace(f"{field}: []", f"{field}: " + json.dumps(invalid))
    with pytest.raises(NoteGenerationError):
        wrapper_metadata(disk)


def test_legacy_faithful_still_rejects_nonempty_tags():
    disk = wrapper("Исходник", version="faithful-v1", tags=["тег"])
    with pytest.raises(NoteGenerationError):
        wrapper_metadata(disk)


@pytest.mark.parametrize(
    "tag", ["<img/onerror=x>", "два слова", "#тег", "123", "а//б", "а" * 81]
)
def test_ru_tags_reject_unsafe_or_noncanonical_tag_syntax_before_cache_bypass(tag):
    with pytest.raises(NoteGenerationError):
        wrapper_metadata(wrapper("Исходник", tags=[tag]))


def test_cache_cannot_bypass_syntax_validation_with_a_forged_ru_wrapper(tmp_path):
    disk = wrapper("Исходник", tags=["<script>boom</script>"])
    (tmp_path / "forged.md").write_text(disk, encoding="utf-8")
    with pytest.raises(NoteGenerationError):
        load_note_cache(tmp_path, lambda _: [], lambda _: [])


def test_legacy_faithful_keeps_empty_tags_and_all_related():
    links = [f"folder/Note-{index}" for index in range(65)]
    source = "Исходник #авторский [[В тексте]]"
    disk = wrapper(source, version="faithful-v1", links=links)
    assert wrapper_metadata(disk)[0]["tags"] == []
    assert extract_note_tags(disk) == []
    assert extract_note_links(disk) == links
    assert extract_service_card("filename", disk)["related"] == links
    assert unwrap_source(disk) == source


def test_generic_frontmatter_keeps_existing_twenty_item_limit():
    tags = [f"тег_{index}" for index in range(25)]
    disk = "---\ntags: " + json.dumps(tags) + "\n---\nИсходник"
    assert len(parse_frontmatter(disk)[0]["tags"]) == 20
    assert len(extract_service_card("filename", disk)["tags"]) == 20


def test_current_body_edits_are_visible_without_accepting_corrupt_creation_receipt():
    original = "  Исходник\r\n"
    current = original + "Правка автора"
    disk = wrapper(original, tags=["существующий"])
    edited = disk[: -len(original)] + current
    metadata, source = current_wrapper_metadata(edited)
    assert source == current
    assert metadata["source_modified"] is True
    assert metadata["tags"] == ["существующий"]
    assert parse_frontmatter(edited)[1] == current
    with pytest.raises(NoteGenerationError):
        wrapper_metadata(edited)


def test_snapshot_captures_tags_from_the_same_secure_bytes(tmp_path):
    source = "\ufeff  Исходник\r\n #вне_каталога"
    tags = [f"существующий_{index}" for index in range(25)]
    disk = wrapper(source, tags=tags)
    path = tmp_path / "nested" / "Название.md"
    path.parent.mkdir()
    path.write_bytes(disk.encode("utf-8"))
    (record,) = snapshot_archive(tmp_path)
    assert record.id == "nested/Название"
    assert record.source == source
    assert record.tags == tuple(tags)
    assert record.disk_sha256 == hashlib.sha256(disk.encode("utf-8")).hexdigest()
    assert_unchanged((record,), tmp_path)
    path.write_bytes(disk.replace("существующий_0", "изменённый_0").encode("utf-8"))
    with pytest.raises(NoteGenerationError):
        assert_unchanged((record,), tmp_path)


def test_snapshot_uses_normalized_existing_legacy_tags_without_new_hashtag_inference(
    tmp_path,
):
    (tmp_path / "legacy.md").write_text("Текст #Работа #Семья", encoding="utf-8")
    (record,) = snapshot_archive(tmp_path)
    assert record.tags == ("работа", "семья")


def test_archive_record_new_field_is_backward_compatible():
    record = ArchiveRecord("id", "title", "source", "path", "digest", False)
    assert record.tags == ()


def test_real_cache_reload_keeps_ru_metadata_and_legacy_filter_behavior(tmp_path):
    tags = [f"тег_{index}" for index in range(25)]
    links = [f"nested/Связь {index}" for index in range(65)]
    source = "\ufeff  Полный исходник\r\n#не_выбран"
    disk = wrapper(source, tags=tags, links=links)
    (tmp_path / "ru.md").write_bytes(disk.encode("utf-8"))
    (tmp_path / "legacy.md").write_text("Обычная заметка", encoding="utf-8")
    seen = []

    def extract(content):
        seen.append(("extract", content))
        return ["старый_тег"]

    def filter_tags(values):
        seen.append(("filter", values))
        return ["старый_фильтр"]

    loaded, inventory = load_note_cache(tmp_path, extract, filter_tags)
    assert loaded["ru"]["tags"] == tags
    assert loaded["ru"]["content"] == disk
    assert extract_note_links(loaded["ru"]["content"]) == links
    assert extract_service_card("ru", disk, tags=["укороченный"])["tags"] == tags
    assert loaded["legacy"]["tags"] == ["старый_фильтр"]
    assert seen == [("extract", "Обычная заметка"), ("filter", ["старый_тег"])]
    assert set(inventory) == {"ru", "legacy"}


def test_unknown_wrapper_version_is_not_reinterpreted():
    disk = wrapper("Исходник", tags=["тег"], version="future-version")
    assert wrapper_metadata(disk) == (None, disk)


def actual_refresh_helper(real_tag_helpers=False):
    path = (
        Path(__file__).resolve().parents[1]
        / "backend/runtime_layers/06_build_plan_items_from_contexts.py"
    )
    tree = ast.parse(path.read_text(encoding="utf-8"))
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_refresh_note_entry_in_cache"
    )
    seen = {"extract": [], "filter": [], "embedding": [], "index": []}

    def extract(content):
        seen["extract"].append(content)
        return ["извлечённый"]

    def filter_tags(values):
        seen["filter"].append(list(values))
        return ["отфильтрованный"]

    def embedding(text, *, vector_size):
        seen["embedding"].append((text, vector_size))
        return [1.0, 0.0]

    namespace = {
        "extract_tags": extract,
        "_filter_tags": filter_tags,
        "_notes_cache_lock": threading.RLock(),
        "notes_data": {},
        "_notes_snapshot": {},
        "_get_vector_size": lambda: 2,
        "generate_embedding": embedding,
        "_clean_note_text_for_rag": lambda text: parse_frontmatter(text)[1],
        "_generate_snippet": lambda text, title: text[:80],
        "_index_notes_in_qdrant": lambda rows: seen["index"].append(rows),
    }
    if real_tag_helpers:
        namespace["extract_tags"] = extract_note_tags
        for filename, names in (
            ("05_select_context.py", {"_deduplicate_tags", "_filter_tags"}),
            ("08_apply_new_model_path.py", {"_normalize_candidate_tag"}),
        ):
            dependency_path = path.with_name(filename)
            dependencies = ast.parse(dependency_path.read_text(encoding="utf-8"))
            functions = [
                node
                for node in dependencies.body
                if isinstance(node, ast.FunctionDef) and node.name in names
            ]
            assert len(functions) == len(names)
            exec(
                compile(
                    ast.Module(body=functions, type_ignores=[]),
                    str(dependency_path),
                    "exec",
                ),
                namespace,
            )
    exec(
        compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"),
        namespace,
    )
    return namespace["_refresh_note_entry_in_cache"], namespace, seen


@pytest.mark.parametrize("edited", [False, True])
def test_watcher_read_refresh_preserves_ru_metadata_and_full_source(tmp_path, edited):
    source = "\ufeff  Полный исходник\r\n#не_из_каталога [[Не выбрана]]  "
    tags = [f"выбранный_{index}" for index in range(25)]
    links = [f"folder/Связь {index}" for index in range(65)]
    content = wrapper(source, tags=tags, links=links)
    if edited:
        content += "\r\nПравка автора"
        source += "\r\nПравка автора"
    path = tmp_path / "Заметка.md"
    path.write_bytes(content.encode("utf-8"))
    refresh, namespace, seen = actual_refresh_helper()
    refresh("Заметка", content, path, existing_tags=["replacement"])
    entry = namespace["notes_data"]["Заметка"]
    assert entry["content"] == content
    assert entry["tags"] == tags
    assert seen["extract"] == seen["filter"] == []
    assert seen["embedding"] == []
    assert seen["index"][0]["Заметка"]["tags"] == tags
    assert seen["index"][0]["Заметка"]["content"] == content
    assert seen["index"][0]["Заметка"]["vector_text"] == source
    assert seen["index"][0]["Заметка"]["vector"] is None
    assert extract_note_links(entry["content"]) == links
    assert extract_service_card("Заметка", entry["content"], tags=[])["tags"] == tags


def test_watcher_read_refresh_retains_legacy_filter_callbacks(tmp_path):
    content = "Обычная заметка #авторский"
    path = tmp_path / "legacy.md"
    path.write_text(content, encoding="utf-8")
    refresh, namespace, seen = actual_refresh_helper()
    refresh("legacy", content, path, existing_tags=["replacement"])
    assert seen["extract"] == [content]
    assert seen["filter"] == [["извлечённый"], ["отфильтрованный", "replacement"]]
    assert namespace["notes_data"]["legacy"]["tags"] == ["отфильтрованный"]


def test_watcher_read_refresh_rejects_invalid_ru_metadata_before_cache_mutation(
    tmp_path,
):
    content = wrapper("Исходник", tags=["<script>unsafe</script>"])
    path = tmp_path / "unsafe.md"
    path.write_text(content, encoding="utf-8")
    refresh, namespace, seen = actual_refresh_helper()
    with pytest.raises(NoteGenerationError):
        refresh("unsafe", content, path, existing_tags=["replacement"])
    assert namespace["notes_data"] == {}
    assert seen["embedding"] == seen["index"] == []


@pytest.mark.parametrize("ru_wrapper", [False, True])
def test_refresh_actual_tag_dependencies_keep_selected_or_legacy_contract(
    tmp_path, ru_wrapper
):
    source = "\ufeff  Исходник\r\n#Работа [[В тексте]]  "
    tags = [f"выбранный_{index}" for index in range(25)]
    links = [f"folder/Связь {index}" for index in range(65)]
    content = wrapper(source, tags=tags, links=links) if ru_wrapper else source
    path = tmp_path / "actual.md"
    path.write_bytes(content.encode("utf-8"))
    refresh, namespace, seen = actual_refresh_helper(real_tag_helpers=True)
    refresh("actual", content, path, existing_tags=["replacement"])
    entry = namespace["notes_data"]["actual"]
    assert entry["tags"] == (tags if ru_wrapper else ["работа", "replacement"])
    assert entry["content"] == content
    assert seen["embedding"] == []
    assert seen["index"][0]["actual"]["content"] == content
    assert seen["index"][0]["actual"]["vector_text"] == source
    assert seen["index"][0]["actual"]["tags"] == entry["tags"]
    assert seen["index"][0]["actual"]["vector"] is None
    if ru_wrapper:
        assert extract_note_links(entry["content"]) == links
