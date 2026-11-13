"""Preserve authored image captions while withholding paths and unseen pixels."""

try:
    from backend.note_generation_contract import protect_attachments
    from backend.markdown_retrieval import image_caption
except ImportError:
    from note_generation_contract import protect_attachments
    from markdown_retrieval import image_caption


def metadata_source(source):
    protected, attachments = protect_attachments(source)
    for marker, original in attachments.items():
        caption = image_caption(original).strip()
        protected = protected.replace(marker, f"![{caption}](attachment)")
    return protected
