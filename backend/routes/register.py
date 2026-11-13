from .generation_routes import register_generation_routes
from .model_routes import register_model_routes
from .notes_routes import register_notes_routes
from .system_routes import register_system_routes
from .project_routes import register_project_routes
from .note_graph_routes import register_note_graph_routes


# Who: Tim Buglaev
# When: 2026-03-26
# What: Added centralized route registration orchestration to keep endpoint wiring explicit and avoid
#       large inline route blocks inside the Flask bootstrap module.
def register_app_routes(app, deps):
    register_project_routes(app, deps)
    register_notes_routes(app, deps)
    register_note_graph_routes(app, deps)
    register_generation_routes(app, deps)
    register_model_routes(app, deps)
    register_system_routes(app, deps)

