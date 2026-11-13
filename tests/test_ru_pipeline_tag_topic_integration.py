"""The actual publication path merges a reviewed catalog topic without duplication."""

import json

from backend.note_faithful_archive import unwrap_source
from backend.note_generation import create_note
from backend.note_generation_contract import extract_note_tags
from backend.ru_pipeline.pair_settings import (
    DEFAULT_PAIRS,
    NEW_TAG_PAIRS,
    NewTags,
    Pair,
    save_selection,
)
from test_ru_pipeline_integration import SyntheticServices, runtime_for


def test_a_rejected_existing_score_can_be_recovered_as_a_reviewed_reused_topic(
    tmp_path,
):
    (tmp_path / "Копии.md").write_text(
        "Настроить резервное копирование базы. #резервное_копирование", encoding="utf-8"
    )
    source = "\ufeff  Перенести резервное копирование на другое время.\r\n  "
    pair = NEW_TAG_PAIRS[0]

    class ReuseServices(SyntheticServices):
        def invoke(self, messages, **parameters):
            payload = json.loads(messages[-1]["content"])
            if payload.get("tag_topic_review"):
                assert payload["source_note"] == source
                return json.dumps(
                    {
                        "selection": {
                            "existing": [payload["catalog"][0]["id"]],
                            "new": [],
                        }
                    }
                )
            if "applied_tags" in payload:
                assert payload["applied_tags"] == []
                return json.dumps(
                    {
                        "new": [
                            {
                                "label": "перенос резервного копирования",
                                "description": "Изменение времени копий",
                            }
                        ]
                    }
                )
            return super().invoke(messages, **parameters)

        def score(self, engine, pairs):
            if engine == "mmarco" and pairs[0]["target"].startswith(
                "резервное_копирование:"
            ):
                return [-10.0] * len(pairs)
            return super().score(engine, pairs)

    runtime = runtime_for(tmp_path, ReuseServices(choose_tags=True, choose_links=False))
    selected = dict(DEFAULT_PAIRS, tags=Pair("qwen35_4b", "mmarco"))
    save_selection(
        runtime.ru_pipeline_config.runtime_dir, selected, NewTags(True, pair)
    )
    result = create_note(runtime, source)
    assert result["tags"] == ["резервное_копирование"]
    assert extract_note_tags(result["content"]) == result["tags"]
    assert result["generation"]["stages"]["new_tags"]["reused_tag_count"] == 1
    assert unwrap_source(result["content"]) == source
    assert (tmp_path / (result["title"] + ".md")).read_bytes() == result[
        "content"
    ].encode()
