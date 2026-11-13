"""The selected tag scorer receives the original label/description wire format."""

import pytest

from backend.ru_pipeline.tag_stage import tag_text


@pytest.mark.parametrize("description", ["Пояснение", "", " \t "])
def test_tag_wire_format_keeps_selected_separator_without_inventing_description(
    description,
):
    row = {"id": "T1", "label": "объект", "description": description}
    assert tag_text(row) == row["label"] + ": " + description
