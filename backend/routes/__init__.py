# Who: Tim Buglaev
# When: 2026-03-26
# What: Added dedicated routes package to host endpoint registration modules and keep Flask entrypoint
#       focused on composition instead of inline HTTP handler implementations.

from .register import register_app_routes

