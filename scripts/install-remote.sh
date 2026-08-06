#!/usr/bin/env bash
set -euo pipefail

# WTF (Why That Failed) — Remote Installer
#
# Install mcp-server-wtf from GitHub Releases without cloning the repo.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-wtf/main/scripts/install-remote.sh | bash
#   curl ... | bash -s -- --uninstall
#   curl ... | bash -s -- --check
#   curl ... | bash -s -- --version v1.0.0

REPO="Wave-Engineering/mcp-server-wtf"
BASE_URL="https://github.com/${REPO}/releases"

INSTALL_DIR="${WTF_INSTALL_DIR:-$HOME/.local/bin}"
DATA_DIR="$HOME/.local/share/wtf-server"
SETTINGS_FILE="$HOME/.claude/settings.json"
HOOK_PATH="$DATA_DIR/hooks/wtf-post-tool-use.sh"

MCP_SERVER_NAME="wtf-server"
VERSION=""

# A jq helper shared by every place that asks "is our hook already registered?".
# Defined ONCE because it is used in three of them (configure_hook, do_check,
# do_uninstall) and they must agree: an installer, a verifier and an uninstaller
# that disagree about what counts as "our hook" produce a hook registered twice,
# a false "not found", and an entry left pointing at a deleted file — all three
# of which have happened here.
#
# Identity is the SCRIPT, not the spelling. Three things obscure it:
#   - `~/…`, `$HOME/…` and `${HOME}/…` are the same file as the absolute path;
#   - a command may carry arguments after the script;
#   - Oak-and-Wave rewrites hook commands as `[ -x <path> ] || exit 0; <path>` so
#     that a hook missing from an older image is inert rather than fatal
#     (cc-workflow#1107). Keying on the wrapper sees `[` as the script and calls
#     a guarded and a bare spelling different hooks — which is exactly the
#     duplicate-registration bug this file exists to fix, one layer out.
read -r -d '' JQ_RESOLVED <<'JQ' || true
def resolved($home):
    (. // "")
    | sub("^\\[ -x [^]]* \\] \\|\\| exit 0;\\s*"; "")
    | sub("^\\s+"; "")
    | (split(" ")[0] // "")
    | if startswith("~/") then $home + .[1:]
      elif startswith("${HOME}/") then $home + .[7:]
      elif startswith("$HOME/") then $home + .[5:]
      else . end;
JQ

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux)  os="linux" ;;
        Darwin) os="darwin" ;;
        *)      die "Unsupported OS: $(uname -s)" ;;
    esac

    case "$(uname -m)" in
        x86_64)         arch="x64" ;;
        aarch64|arm64)  arch="arm64" ;;
        *)              die "Unsupported architecture: $(uname -m)" ;;
    esac

    PLATFORM_OS="$os"
    PLATFORM_ARCH="$arch"
    BINARY_NAME="wtf-server-${os}-${arch}"
}

# ---------------------------------------------------------------------------
# Download helper (curl or wget)
# ---------------------------------------------------------------------------

fetch() {
    local url="$1" dest="$2"
    local tmp="${dest}.tmp.$$"
    if command -v curl &>/dev/null; then
        curl -fsSL "$url" -o "$tmp"
    elif command -v wget &>/dev/null; then
        wget -q "$url" -O "$tmp"
    else
        die "Neither curl nor wget found"
    fi
    mv -f "$tmp" "$dest"
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

check_prereqs() {
    local missing=0
    for cmd in claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            missing=1
        fi
    done
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        fail "Neither curl nor wget found"
        missing=1
    else
        ok "$(command -v curl &>/dev/null && echo curl || echo wget) available"
    fi
    if [[ $missing -ne 0 ]]; then
        die "Install missing prerequisites and try again."
    fi
}

# ---------------------------------------------------------------------------
# Resolve download URL
# ---------------------------------------------------------------------------

resolve_url() {
    local file="$1"
    if [[ -n "$VERSION" ]]; then
        echo "${BASE_URL}/download/${VERSION}/${file}"
    else
        echo "${BASE_URL}/latest/download/${file}"
    fi
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

do_install() {
    echo ""
    echo "WTF (Why That Failed) — Remote Installer"
    echo "=========================================="
    echo ""

    echo "Checking prerequisites..."
    check_prereqs
    echo ""

    detect_platform
    info "Platform: ${PLATFORM_OS}-${PLATFORM_ARCH}"
    echo ""

    # Download binary
    info "Downloading ${BINARY_NAME}..."
    mkdir -p "$INSTALL_DIR"
    fetch "$(resolve_url "$BINARY_NAME")" "${INSTALL_DIR}/wtf-server"
    chmod +x "${INSTALL_DIR}/wtf-server"
    ok "Binary installed to ${INSTALL_DIR}/wtf-server"
    echo ""

    # Download hook script
    info "Downloading hook script..."
    mkdir -p "$DATA_DIR/hooks"
    fetch "$(resolve_url "wtf-post-tool-use.sh")" "$HOOK_PATH"
    chmod +x "$HOOK_PATH"
    ok "Hook installed to $HOOK_PATH"
    echo ""

    # Register MCP server (remove first for idempotency)
    info "Registering MCP server: $MCP_SERVER_NAME"
    claude mcp remove "$MCP_SERVER_NAME" 2>/dev/null || true
    claude mcp add --scope user --transport stdio "$MCP_SERVER_NAME" \
        -- "${INSTALL_DIR}/wtf-server"
    ok "MCP server registered"
    echo ""

    # Configure PostToolUse hook
    configure_hook
    echo ""

    # Verify install dir is on PATH
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        warn "${INSTALL_DIR} is not on your PATH"
        info "Add it: export PATH=\"${INSTALL_DIR}:\$PATH\""
    fi

    echo ""
    echo "Installation Summary"
    echo "--------------------"
    ok "Binary: ${INSTALL_DIR}/wtf-server"
    ok "Hook: PostToolUse → $HOOK_PATH"
    ok "Data dir: .claude/wtf/ (created on first use, per project)"
    echo ""
    echo "Start a troubleshooting session:  /wtf"
    echo "Record an observation:            /wtf now <text>"
    echo "Get the timeline:                 /wtf happened"
    echo ""
}

# ---------------------------------------------------------------------------
# Hook configuration (matches install.sh logic)
# ---------------------------------------------------------------------------

configure_hook() {
    info "Configuring PostToolUse hook..."

    mkdir -p "$(dirname "$SETTINGS_FILE")"
    if [[ ! -f "$SETTINGS_FILE" ]]; then
        echo '{}' > "$SETTINGS_FILE"
    fi

    local hook_entry
    hook_entry=$(jq -n --arg cmd "$HOOK_PATH" \
        '{"matcher":"","hooks":[{"type":"command","command":$cmd}]}')

    # COMPARE RESOLVED PATHS, NOT RAW STRINGS. HOOK_PATH is absolute (built from
    # $HOME); a template-seeded settings file spells the same hook
    # `~/.local/share/...`. A string compare called those two different hooks and
    # registered the recorder TWICE, firing twice on every tool use.
    local updated
    updated=$(jq --argjson entry "$hook_entry" --arg home "$HOME" "$JQ_RESOLVED"'
        .hooks //= {} |
        .hooks.PostToolUse //= [] |
        if (.hooks.PostToolUse
              | map(.hooks // [] | map(select(
                    (.command | resolved($home)) == ($entry.hooks[0].command | resolved($home))
                )))
              | flatten | length) > 0
        then .
        else .hooks.PostToolUse += [$entry]
        end
    ' "$SETTINGS_FILE")

    printf '%s\n' "$updated" > "$SETTINGS_FILE"
    ok "PostToolUse hook configured"
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

do_uninstall() {
    echo ""
    echo "WTF — Remote Uninstaller"
    echo "========================"
    echo ""

    # Remove binary
    if [[ -f "${INSTALL_DIR}/wtf-server" ]]; then
        rm "${INSTALL_DIR}/wtf-server"
        ok "Removed binary"
    else
        warn "Binary not found at ${INSTALL_DIR}/wtf-server"
    fi

    # Remove MCP registration
    info "Removing MCP server registration..."
    if claude mcp remove "$MCP_SERVER_NAME" 2>/dev/null; then
        ok "MCP server removed"
    else
        warn "MCP server was not registered"
    fi

    # Remove hook from settings
    info "Removing PostToolUse hook..."
    if [[ -f "$SETTINGS_FILE" ]]; then
        # Resolve here too, and for the sharpest reason of the three: the data dir
        # is deleted a few lines below. A raw-string compare leaves a ~-spelled
        # entry in place, pointing at the script that just went away, so every
        # tool call afterwards prints
        #   /bin/sh: 1: …/wtf-post-tool-use.sh: not found
        # An uninstall that disagrees with its own installer about what it
        # registered does not just fail to clean up — it leaves the user broken.
        local updated
        updated=$(jq --arg cmd "$HOOK_PATH" --arg home "$HOME" "$JQ_RESOLVED"'
            if .hooks.PostToolUse then
                .hooks.PostToolUse |= map(
                    if (.hooks // [] | map(select((.command | resolved($home)) == ($cmd | resolved($home)))) | length) > 0
                    then .hooks |= map(select((.command | resolved($home)) != ($cmd | resolved($home))))
                    else .
                    end
                ) |
                .hooks.PostToolUse |= map(select((.hooks // []) | length > 0)) |
                if (.hooks.PostToolUse | length) == 0 then del(.hooks.PostToolUse) else . end |
                if (.hooks | length) == 0 then del(.hooks) else . end
            else .
            end
        ' "$SETTINGS_FILE")
        printf '%s\n' "$updated" > "$SETTINGS_FILE"
        ok "Hook removed"
    fi

    # Remove data dir
    if [[ -d "$DATA_DIR" ]]; then
        rm -rf "$DATA_DIR"
        ok "Removed $DATA_DIR"
    fi

    echo ""
    ok "Uninstall complete"
    info "Per-project .claude/wtf/ directories were not removed (contain incident history)."
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
    for cmd in claude jq; do
        if command -v "$cmd" &>/dev/null; then
            ok "$cmd available"
        else
            fail "$cmd not found"
            issues=$((issues + 1))
        fi
    done

    # Binary
    if [[ -x "${INSTALL_DIR}/wtf-server" ]]; then
        ok "Binary at ${INSTALL_DIR}/wtf-server"
    else
        fail "Binary not found at ${INSTALL_DIR}/wtf-server"
        issues=$((issues + 1))
    fi

    # MCP registration
    if claude mcp list 2>/dev/null | grep -q "$MCP_SERVER_NAME"; then
        ok "MCP server registered"
    else
        fail "MCP server not registered"
        issues=$((issues + 1))
    fi

    # Hook. Resolves paths for the same reason configure_hook does — and it matters
    # MORE here: a raw-string compare made this report "hook not found" on a host
    # where the hook IS configured, just spelled with a `~`. A verifier that
    # disagrees with the installer about what "installed" means is worse than no
    # verifier, because it sends people looking for a problem that is not there.
    if [[ -f "$SETTINGS_FILE" ]] && \
       jq -e --arg cmd "$HOOK_PATH" --arg home "$HOME" "$JQ_RESOLVED"'
          .hooks.PostToolUse // []
            | map(.hooks // [] | map(select((.command | resolved($home)) == ($cmd | resolved($home)))))
            | flatten | length > 0' \
          "$SETTINGS_FILE" &>/dev/null; then
        ok "PostToolUse hook configured"
    else
        fail "PostToolUse hook not found"
        issues=$((issues + 1))
    fi

    echo ""
    if [[ $issues -eq 0 ]]; then
        ok "All checks passed"
    else
        fail "$issues issue(s) found"
        info "Run the installer to fix: curl -fsSL ...install-remote.sh | bash"
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# Only dispatch when EXECUTED — see install.sh for why sourcing must be inert.
# `curl … | bash` reads this script from STDIN, where BASH_SOURCE is unset —
# under `set -u` a bare expansion aborts before dispatch, and the documented
# install path is exactly that pipe. Default to $0 so the piped case dispatches
# and a sourced caller (BASH_SOURCE = this file, $0 = the caller) still does not.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --uninstall) ACTION="uninstall"; shift ;;
            --check)     ACTION="check"; shift ;;
            --version)   VERSION="${2:?--version requires a tag}"; shift 2 ;;
            *)           die "Unknown flag: $1 (use --uninstall, --check, or --version <tag>)" ;;
        esac
    done

    case "${ACTION:-install}" in
        install)   do_install ;;
        uninstall) do_uninstall ;;
        check)     do_check ;;
    esac
fi
