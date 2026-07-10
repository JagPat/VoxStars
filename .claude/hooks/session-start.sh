#!/bin/bash
# SessionStart hook: install Node dependencies so `npm test` and
# `npm run check` work immediately in Claude Code on the web sessions.
set -euo pipefail

# Only run in Claude Code on the web (remote) sessions; local sessions
# manage their own environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# npm install is idempotent and benefits from the cached container state
# (unlike npm ci, which wipes node_modules every run). Progress goes to
# stderr so it is logged without being injected into the session context.
echo "session-start: installing npm dependencies..." >&2
npm install --no-audit --no-fund >&2
echo "session-start: dependencies ready." >&2
