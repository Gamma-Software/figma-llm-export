#!/usr/bin/env bash
#
# figma-to-code — one-line installer for the Claude Code plugin.
#
#   curl -fsSL https://raw.githubusercontent.com/Gamma-Software/figma-llm-export/main/install.sh | bash
#
# Adds this repo as a Claude Code marketplace and installs the figma-to-code
# plugin (a skill + a subagent that turn a figma-llm-export payload into code).
# Pure bash — drives the `claude` CLI, no Node required.
#
# Env overrides:
#   SCOPE=user|project|local   install scope (default: user)
#
set -euo pipefail

REPO="Gamma-Software/figma-llm-export"   # GitHub owner/repo (the marketplace source)
MARKET="figma-llm-export"                # marketplace.json -> "name"
PLUGIN="figma-to-code"                   # plugin.json -> "name"
SCOPE="${SCOPE:-user}"                   # user | project | local

c_reset=$'\033[0m'; c_b=$'\033[1m'; c_cy=$'\033[36m'; c_gn=$'\033[32m'
c_yl=$'\033[33m'; c_rd=$'\033[31m'
bold() { printf '%s%s%s\n' "$c_b" "$*" "$c_reset"; }
info() { printf '  %s›%s %s\n' "$c_cy" "$c_reset" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_gn" "$c_reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yl" "$c_reset" "$*"; }
die()  { printf '  %s✗ %s%s\n' "$c_rd" "$*" "$c_reset" >&2; exit 1; }

bold "Installing the ${PLUGIN} Claude Code plugin"

command -v claude >/dev/null 2>&1 || die \
  "Claude Code CLI not found on PATH. Install it first: https://docs.claude.com/en/docs/claude-code — then re-run this."

info "Adding marketplace ${REPO} …"
if claude plugin marketplace add "$REPO" --scope "$SCOPE" >/dev/null 2>&1; then
  ok "marketplace added"
else
  # Likely already present — refresh it so we install the latest.
  claude plugin marketplace update "$MARKET" >/dev/null 2>&1 || true
  ok "marketplace already present (refreshed)"
fi

info "Installing ${PLUGIN}@${MARKET} (scope: ${SCOPE}) …"
claude plugin install "${PLUGIN}@${MARKET}" --scope "$SCOPE" \
  || die "install failed — try: claude plugin install ${PLUGIN}@${MARKET}"

if claude plugin list 2>/dev/null | grep -q "${PLUGIN}@${MARKET}"; then
  ok "verified: ${PLUGIN} is installed and enabled"
else
  warn "installed, but not shown by 'claude plugin list' — check 'claude plugin list'"
fi

echo
bold "Done."
echo "  Restart Claude Code (or run /reload-plugins) to load it."
echo "  Then export a selection from the LLM Export Figma plugin, save the .json,"
echo "  and ask Claude to implement it — or run /${PLUGIN}:${PLUGIN}."
