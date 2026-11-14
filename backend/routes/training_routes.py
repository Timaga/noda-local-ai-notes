"""Keep retired training endpoints explicit and free of training side effects."""

from flask import jsonify

from backend.training_pipeline import disabled_training_status


def register_disabled_training_routes(app):
    @app.post("/training/run")
    def training_run():
        return jsonify(disabled_training_status()), 410

    @app.get("/training/status")
    def training_status():
        return jsonify({"runtime": disabled_training_status(), "file": {}})
