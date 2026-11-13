"""Read-only graph transport under the existing project switch barrier."""

from typing import TYPE_CHECKING

from flask import jsonify, request

if TYPE_CHECKING or __package__ == "backend.routes":
    from backend.note_graph import GraphLimitError, build_note_graph
    from backend.note_faithful_archive import NoteSystemError
    from backend.note_live_state import (
        NotesStateError,
        capture_notes_state,
        parse_live_query,
    )
else:
    from note_graph import GraphLimitError, build_note_graph
    from note_faithful_archive import NoteSystemError
    from note_live_state import NotesStateError, capture_notes_state, parse_live_query


def register_note_graph_routes(app, deps):
    @app.after_request
    def graph_cache_policy(response):
        if request.endpoint == "get_note_graph":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/notes-graph")
    def get_note_graph():
        try:
            if set(request.args) - {"live", "if_revision", "expected_vault_id"}:
                raise ValueError("Unknown graph query")
            live, previous, expected = parse_live_query(request.args)
        except ValueError:
            return jsonify(error="Invalid graph query"), 400
        try:
            if not live:
                deps.module._reload_notes_cache(reason="/notes-graph")
            state = capture_notes_state(deps.module)
            if state.vault_id is None:
                raise NotesStateError("Vault unavailable")
            if expected is not None and expected != state.vault_id:
                return jsonify(error="Vault changed", code="vault_changed"), 409
            context = {"vault_id": state.vault_id, "revision": state.revision}
            if previous == state.revision:
                return jsonify(unchanged=True, **context)
            return jsonify(**build_note_graph(state), **context)
        except GraphLimitError:
            return jsonify(error="Graph size limit exceeded", code="graph_limit"), 413
        except (NotesStateError, NoteSystemError, ValueError, TypeError, OSError):
            app.logger.warning("Note graph snapshot unavailable")
            return jsonify(error="Graph unavailable", code="graph_unavailable"), 503
