#!/usr/bin/env bash
set -euo pipefail

# WTF (Why That Failed) — installer
#
# Idempotent installer for the WTF flight recorder system. Registers the
# MCP server, installs skills, and configures the PostToolUse hook.
#
# Usage:
#   ./scripts/install.sh              Install everything
#   ./scripts/install.sh --check      Verify installation
#   ./scripts/install.sh --uninstall  Remove everything

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_DIR="$PROJECT_DIR"
HOOK_PATH="$PROJECT_DIR/scripts/hooks/wtf-post-tool-use.sh"
SKILLS_DIR="$HOME/.claude/skills"
SETTINGS_FILE="$HOME/.claude/settings.json"

MCP_SERVER_NAME="wtf-server"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prereqs() {
    local missing=0
    for cmd in bun claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd $(command "$cmd" --version 2>&1 | head -1)"
        else
            fail "$cmd not found"
            missing=1
        fi
    done
    if [[ $missing -ne 0 ]]; then
        die "Install missing prerequisites and try again."
    fi
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

install_deps() {
    info "Installing MCP server dependencies..."
    (cd "$MCP_DIR" && bun install --frozen-lockfile)
    ok "bun install complete"
}

register_mcp() {
    # claude mcp add is idempotent — it overwrites an existing entry with the
    # same name, so running twice is safe.
    info "Registering MCP server: $MCP_SERVER_NAME"
    claude mcp add --scope user --transport stdio "$MCP_SERVER_NAME" \
        -- bun "$MCP_DIR/index.ts"
    ok "MCP server registered (scope: user)"
}

install_skills() {
    info "Installing skills to $SKILLS_DIR"
    mkdir -p "$SKILLS_DIR/wtf" "$SKILLS_DIR/wtf-now" "$SKILLS_DIR/wtf-happened" "$SKILLS_DIR/wtf-imout"
    cp "$PROJECT_DIR/skills/wtf/SKILL.md" "$SKILLS_DIR/wtf/SKILL.md"
    cp "$PROJECT_DIR/skills/wtf-now/SKILL.md" "$SKILLS_DIR/wtf-now/SKILL.md"
    cp "$PROJECT_DIR/skills/wtf-happened/SKILL.md" "$SKILLS_DIR/wtf-happened/SKILL.md"
    cp "$PROJECT_DIR/skills/wtf-imout/SKILL.md" "$SKILLS_DIR/wtf-imout/SKILL.md"
    ok "Installed /wtf, /wtf now, /wtf happened, and /wtf imout skills"
}

configure_hook() {
    info "Configuring PostToolUse hook in $SETTINGS_FILE"

    # Ensure the settings file exists.
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    if [[ ! -f "$SETTINGS_FILE" ]]; then
        echo '{}' > "$SETTINGS_FILE"
    fi

    # Build the hook entry in the matcher + hooks array format.
    # Format: {"matcher": "", "hooks": [{"type": "command", "command": "..."}]}
    # Empty matcher matches all tool uses.
    local hook_entry
    hook_entry=$(jq -n --arg cmd "$HOOK_PATH" '{"matcher":"","hooks":[{"type":"command","command":$cmd}]}')

    # Smart-merge: add the hook only if it is not already present.
    local updated
    updated=$(jq --argjson entry "$hook_entry" '
        # Ensure .hooks.PostToolUse is an array.
        .hooks //= {} |
        .hooks.PostToolUse //= [] |
        # Check if any existing matcher group already contains our command.
        if (.hooks.PostToolUse | map(.hooks // [] | map(select(.command == $entry.hooks[0].command))) | flatten | length) > 0
        then .
        else .hooks.PostToolUse += [$entry]
        end
    ' "$SETTINGS_FILE")

    printf '%s\n' "$updated" > "$SETTINGS_FILE"
    ok "PostToolUse hook configured"
}

do_install() {
    echo ""
    echo "WTF (Why That Failed) — Installer"
    echo "=================================="
    echo ""

    echo "Checking prerequisites..."
    check_prereqs
    echo ""

    install_deps
    echo ""

    register_mcp
    echo ""

    install_skills
    echo ""

    configure_hook
    echo ""

    echo "Installation Summary"
    echo "--------------------"
    ok "MCP server: $MCP_SERVER_NAME (bun $MCP_DIR/index.ts)"
    ok "Skills: ~/.claude/skills/wtf/, ~/.claude/skills/wtf-now/, ~/.claude/skills/wtf-happened/"
    ok "Hook: PostToolUse → $HOOK_PATH"
    ok "Data dir: .wtf/ (created on first use)"
    echo ""
    echo "Start a troubleshooting session:  /wtf"
    echo "Record an observation:            /wtf now <text>"
    echo "Get the timeline:                 /wtf happened"
    echo ""
}

# ---------------------------------------------------------------------------
# Check
# ---------------------------------------------------------------------------

do_check() {
    echo ""
    echo "WTF — Installation Check"
    echo "========================"
    echo ""
    local issues=0

    # Prerequisites
    for cmd in bun claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            issues=$((issues + 1))
        fi
    done

    # MCP registration — check claude mcp list output
    if claude mcp list 2>/dev/null | grep -q "$MCP_SERVER_NAME"; then
        ok "MCP server '$MCP_SERVER_NAME' registered"
    else
        fail "MCP server '$MCP_SERVER_NAME' not registered"
        issues=$((issues + 1))
    fi

    # Skills
    for skill in wtf wtf-now wtf-happened wtf-imout; do
        if [[ -f "$SKILLS_DIR/$skill/SKILL.md" ]]; then
            ok "Skill /$skill installed"
        else
            fail "Skill /$skill not found at $SKILLS_DIR/$skill/SKILL.md"
            issues=$((issues + 1))
        fi
    done

    # Hook
    if [[ -f "$SETTINGS_FILE" ]] && \
       jq -e --arg cmd "$HOOK_PATH" \
          '.hooks.PostToolUse // [] | map(.hooks // [] | map(select(.command == $cmd))) | flatten | length > 0' \
          "$SETTINGS_FILE" &>/dev/null; then
        ok "PostToolUse hook configured"
    else
        fail "PostToolUse hook not found in $SETTINGS_FILE"
        issues=$((issues + 1))
    fi

    # Node modules
    if [[ -d "$MCP_DIR/node_modules" ]]; then
        ok "MCP server dependencies installed"
    else
        fail "MCP server dependencies not installed (run bun install)"
        issues=$((issues + 1))
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        ok "All checks passed"
    else
        fail "$issues issue(s) found — run ./scripts/install.sh to fix"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
    echo ""
    echo "WTF — Uninstaller"
    echo "=================="
    echo ""

    # Remove MCP registration
    info "Removing MCP server registration..."
    if claude mcp remove "$MCP_SERVER_NAME" 2>/dev/null; then
        ok "MCP server '$MCP_SERVER_NAME' removed"
    else
        warn "MCP server '$MCP_SERVER_NAME' was not registered"
    fi

    # Remove skills
    info "Removing skills..."
    for skill in wtf wtf-now wtf-happened wtf-imout; do
        if [[ -f "$SKILLS_DIR/$skill/SKILL.md" ]]; then
            rm "$SKILLS_DIR/$skill/SKILL.md"
            rmdir "$SKILLS_DIR/$skill" 2>/dev/null || true
            ok "Removed skill /$skill"
        else
            warn "Skill /$skill was not installed"
        fi
    done

    # Remove hook from settings
    info "Removing PostToolUse hook from settings..."
    if [[ -f "$SETTINGS_FILE" ]]; then
        local updated
        updated=$(jq --arg cmd "$HOOK_PATH" '
            if .hooks.PostToolUse then
                # Remove any matcher group whose hooks array contains our command.
                .hooks.PostToolUse |= map(
                    if (.hooks // [] | map(select(.command == $cmd)) | length) > 0
                    then .hooks |= map(select(.command != $cmd))
                    else .
                    end
                ) |
                # Remove matcher groups with empty hooks arrays.
                .hooks.PostToolUse |= map(select((.hooks // []) | length > 0)) |
                if (.hooks.PostToolUse | length) == 0 then del(.hooks.PostToolUse) else . end |
                if (.hooks | length) == 0 then del(.hooks) else . end
            else .
            end
        ' "$SETTINGS_FILE")
        printf '%s\n' "$updated" > "$SETTINGS_FILE"
        ok "PostToolUse hook removed"
    else
        warn "Settings file not found"
    fi

    echo ""
    ok "Uninstall complete"
    info "The .wtf/ data directory was not removed (contains incident history)."
    info "To remove it: rm -rf .wtf/"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-}" in
    --check)     do_check ;;
    --uninstall) do_uninstall ;;
    "")          do_install ;;
    *)           die "Unknown flag: $1 (use --check or --uninstall)" ;;
esac
