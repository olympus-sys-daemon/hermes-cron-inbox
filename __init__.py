"""Agent half of the Hermes Inbox package.

The HTTP routes live in ``dashboard/plugin_api.py`` and mount under
``/api/plugins/hermes-inbox/``. The desktop page lives in ``desktop/plugin.js``.

Nothing is registered with the agent: this plugin adds no tools, no hooks and
no commands. It reads the cron run documents Hermes already writes and keeps
its own read/mute state in ``<HERMES_HOME>/plugin-data/hermes-inbox/``.
"""


def register(ctx):
    # Deliberately empty: a pure view over files that already exist.
    return None
