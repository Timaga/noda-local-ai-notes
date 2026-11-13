"""New tags remain reusable topic names rather than complete task sentences."""

import json
import pytest
from backend.ru_pipeline.new_tag_stage import _decode


@pytest.mark.parametrize(
    "label",
    [
        "CRM",
        "финансовая математика",
        "резервное_копирование",
        "two factor authentication",
    ],
)
def test_short_new_topic_labels_are_preserved(label):
    result = _decode(
        json.dumps({"new": [{"label": label, "description": "Основная тема заметки"}]}),
        [],
    )
    assert len(result) == 1 and result[0]["label"] == label


@pytest.mark.parametrize(
    "label",
    [
        "созвон по курсу тим лида",
        "call about configuring the database",
        "созвон_по_курсу_тим_лида",
    ],
)
def test_a_task_sentence_is_not_a_reusable_topic_name(label):
    with pytest.raises(ValueError):
        _decode(json.dumps({"new": [{"label": label, "description": "Тема"}]}), [])
