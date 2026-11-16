#!/bin/bash
########################################
# Ionnet GSS host agent install script #
########################################
# Served by the panel at /api/agent/install.sh with the two @…@ values filled in. Usage:
#   curl -fsSL https://gss.example.com/api/agent/install.sh | sudo bash
# The script asks for the enrol token on the terminal (never on a command line). For automation, put it in the
# GSS_ENROL_TOKEN environment variable and keep it with sudo -E.
# Contracts: STRUCTURE.md "M5: tenancy" (Agent install). Exit codes: 0 ok, 1 failure, 2 bad arguments, 3 unsupported.

GSS_INSTALLER_VERSION="0.1.0"
PANEL_URL="@PANEL_URL@" # Replaced by the panel with PUBLIC_URL; --panel overrides it.
INSECURE="@INSECURE@" # 1 = pass --insecure to enrol (plain http:// panel on another machine).
BIN_PATH="/usr/local/bin/gss-agent"
UNIT_PATH="/etc/systemd/system/gss-agent.service"
CONFIG_PATH="/etc/ionnet-gss/agent.json"
DATA_DIR="/var/lib/ionnet-gss"
DRY_RUN=0
ASSUME_YES=0
NO_START=0
PURGE=0
DISTRO=""
ARCH=""
SYSTEMD_OK=1
SERVICE_ACTIVE=0
TMP_FILE=""
ENROL_TOKEN="${GSS_ENROL_TOKEN:-}"
unset GSS_ENROL_TOKEN # Never inherited by the commands below; it only reaches gss-agent through stdin.
DOCKER_PACKAGE=""
NFTABLES_INSTALLED=0

# Print a green status line.
printf_green() {
  printf "\033[32m%s\033[0m\n" "$1"
}

# Print a red error line to stderr.
printf_red() {
  printf "\033[31m%s\033[0m\n" "$1" >&2
}

# Print a yellow warning line to stderr.
printf_yellow() {
  printf "\033[33m%s\033[0m\n" "$1" >&2
}

# Print a red error line and exit with the given code.
fail() {
  local CODE="$1"
  printf_red "$2"
  exit "$CODE"
}

# Remove the temporary download when the script ends, however it ends.
cleanup() {
  [[ -n "$TMP_FILE" ]] && rm -f "$TMP_FILE"
}
trap cleanup EXIT

# Run a command, or only print it with --dry-run. Stdin is closed: the script itself may arrive on stdin (curl | bash).
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  + $*"
    return 0
  fi
  "$@" </dev/null
}

# Print the help table, or a command's options.
print_help() {
  case "$1" in
    install)
      echo "Install or upgrade the Ionnet GSS host agent on this machine."
      echo "Usage: install-agent.sh install [--panel URL] [--insecure] [--no-start] [--dry-run]"
      echo "Options:"
      echo "      --panel URL   Panel address (default: the panel this script came from)"
      echo "      --insecure    Allow a plain http:// panel on another machine"
      echo "      --no-start    Enable the service but don't start it"
      echo "      --dry-run     Print each step instead of changing the system (the download is still checked)"
      echo "  -y, --yes         Don't ask questions"
      echo "The first install asks for the enrol token (typed, not shown). For automation set GSS_ENROL_TOKEN and use sudo -E."
      ;;
    uninstall)
      echo "Stop and remove the agent service and binary."
      echo "Usage: install-agent.sh uninstall [--purge] [-y]"
      echo "Options:"
      echo "      --purge       Also delete /etc/ionnet-gss (credential) and /var/lib/ionnet-gss (game server data)"
      echo "      --dry-run     Print each step instead of changing the system"
      echo "  -y, --yes         Don't ask for confirmation"
      ;;
    "")
      echo "Ionnet GSS host agent installer $GSS_INSTALLER_VERSION"
      echo
      echo "Commands:"
      echo "  install [--panel URL] [--insecure] [--no-start] [--dry-run]   Install or upgrade the agent (default)"
      echo "  uninstall [--purge] [-y]                                      Remove the agent service and binary"
      echo "  help [command]                                                Show this help"
      echo "  version                                                       Print the installer version"
      echo
      echo "Run \"install-agent.sh help <command>\" for more information on a command."
      ;;
    *)
      echo "Command not found: $1"
      return 2
      ;;
  esac
}

# Parse flags after the command into the globals above; unknown flags exit 2.
parse_flags() {
  local PANEL_GIVEN=0 INSECURE_GIVEN=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --panel)
        [[ -n "${2:-}" ]] || fail 2 "--panel needs a URL, e.g. --panel https://gss.example.com"
        PANEL_URL="$2"
        PANEL_GIVEN=1
        shift 2
        ;;
      --panel=*)
        PANEL_URL="${1#--panel=}"
        PANEL_GIVEN=1
        shift
        ;;
      --insecure) INSECURE_GIVEN=1; shift ;;
      --no-start) NO_START=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --purge) PURGE=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      *) fail 2 "Unknown option: $1. Run \"install-agent.sh help\" for the options." ;;
    esac
  done
  if [[ "$PANEL_GIVEN" == "1" ]]; then
    INSECURE=0
  fi
  [[ "$INSECURE_GIVEN" == "1" ]] && INSECURE=1
  PANEL_URL="${PANEL_URL%/}"
  # The placeholder is split so the panel's substitution doesn't rewrite this comparison too.
  if [[ "$PANEL_URL" == "@PANEL_""URL@" || -z "$PANEL_URL" ]]; then
    fail 2 "No panel address. Fetch this script from the panel (/api/agent/install.sh) or pass --panel https://gss.example.com"
  fi
  [[ "$PANEL_URL" =~ ^https?://[^[:space:]]+$ ]] || fail 2 "The panel address must start with http:// or https:// (got: $PANEL_URL)."
  return 0
}

# Require root (exit 1 with "Run this as root, e.g. with sudo.").
check_root() {
  [[ "$DRY_RUN" == "1" ]] && return 0
  [[ "$EUID" -eq 0 ]] || fail 1 "Run this as root, e.g. with sudo."
}

# Set DISTRO to arch or debian from /etc/arch-release / /etc/debian_version, require systemd; else exit 3.
detect_distro() {
  local UNSUPPORTED="Only Arch Linux and Debian/Ubuntu with systemd are supported."
  if [[ -f /etc/arch-release ]]; then
    DISTRO="arch"
    DOCKER_PACKAGE="docker"
  elif [[ -f /etc/debian_version ]]; then
    DISTRO="debian"
    DOCKER_PACKAGE="docker.io"
  else
    local NAME
    NAME="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
    fail 3 "$UNSUPPORTED This system reports itself as: ${NAME:-unknown}."
  fi
  if [[ ! -d /run/systemd/system ]] || ! command -v systemctl >/dev/null 2>&1; then
    SYSTEMD_OK=0
    if [[ "$DRY_RUN" == "1" ]]; then
      printf_yellow "systemd is not running here; a real install would stop at this point."
    else
      fail 3 "$UNSUPPORTED systemd is not running on this machine."
    fi
  fi
  command -v curl >/dev/null 2>&1 || fail 1 "curl is required. Install it with your package manager and run this again."
  return 0
}

# Set ARCH to amd64 or arm64 from `uname -m`; else exit 3 naming the architecture.
detect_arch() {
  local MACHINE
  MACHINE="$(uname -m)"
  case "$MACHINE" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) fail 3 "The agent is built for x86_64 and arm64 only. Your architecture was reported as: $MACHINE" ;;
  esac
}

# Install packages with pacman or apt (non-interactive).
pkg_install() {
  if [[ "$DISTRO" == "arch" ]]; then
    run pacman -S --needed --noconfirm "$@" || {
      printf_red "pacman couldn't install: $*. If its package database is out of date, update the system first with \"pacman -Syu\" and run this again."
      return 1
    }
  else
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" || {
      printf_red "apt couldn't install: $*. Check the messages above."
      return 1
    }
  fi
}

# Refresh apt's package lists (Arch is left alone: a partial upgrade would be worse than a stale database).
pkg_refresh() {
  [[ "$DISTRO" == "debian" ]] || return 0
  run apt-get update || return 1
}

# Make sure Docker is installed, enabled and running (docker on Arch, docker.io on Debian/Ubuntu).
ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "Docker is already installed."
  else
    echo "Installing Docker ($DOCKER_PACKAGE)..."
    pkg_install "$DOCKER_PACKAGE" || return 1
  fi
  if [[ "$SYSTEMD_OK" == "1" ]]; then
    run systemctl enable --now docker || { printf_red "Couldn't start the docker service. Check \"systemctl status docker\"."; return 1; }
    if [[ "$DRY_RUN" != "1" ]] && ! docker info >/dev/null 2>&1; then
      printf_yellow "Docker is installed but doesn't answer yet. The agent keeps retrying; check \"systemctl status docker\" if the host stays offline."
    fi
  fi
}

# Install the nftables package (the kernel tables the agent's nft helper uses), but never enable nftables.service:
# Debian's /etc/nftables.conf starts with `flush ruleset`, which would wipe Docker's and the agent's rules.
ensure_nftables() {
  if command -v nft >/dev/null 2>&1; then
    echo "nftables is already installed."
    return 0
  fi
  echo "Installing nftables (the service stays disabled)..."
  pkg_install nftables || return 1
  NFTABLES_INSTALLED=1
  # Debian's package enables its service on install; undo that, since only this run caused it.
  if [[ "$SYSTEMD_OK" == "1" && "$DRY_RUN" != "1" ]] && systemctl is-enabled nftables.service >/dev/null 2>&1; then
    run systemctl disable nftables.service || printf_yellow "Couldn't disable nftables.service. Run \"systemctl disable nftables\" yourself."
  fi
  return 0
}

# GET a URL into a file; on a non-200 answer print the panel's own message (its JSON "message") and return 1.
http_get() {
  local URL="$1" OUT="$2" CODE
  CODE="$(curl -sS --connect-timeout 10 --max-time 600 --retry 2 -o "$OUT" -w '%{http_code}' "$URL" </dev/null)" || {
    printf_red "Couldn't reach $URL. Check that the panel address is right and reachable from this machine."
    return 1
  }
  if [[ "$CODE" != "200" ]]; then
    local MESSAGE
    MESSAGE="$(sed -n 's/.*"message" *: *"\([^"]*\)".*/\1/p' "$OUT" 2>/dev/null | head -n 1)"
    printf_red "Download failed (HTTP $CODE): ${MESSAGE:-$URL}"
    return 1
  fi
}

# Download the agent for ARCH to BIN_PATH.new, verify it against /api/agent/download/linux/ARCH/sha256, rename it.
agent_download() {
  local URL="$PANEL_URL/api/agent/download/linux/$ARCH" TARGET EXPECTED ACTUAL
  if [[ "$DRY_RUN" == "1" ]]; then
    TMP_FILE="$(mktemp)"
    TARGET="$TMP_FILE"
  else
    TARGET="$BIN_PATH.new"
    TMP_FILE="$TARGET"
  fi
  echo "Downloading gss-agent (linux/$ARCH) from $PANEL_URL..."
  EXPECTED="$(mktemp)"
  http_get "$URL/sha256" "$EXPECTED" || { rm -f "$EXPECTED"; return 1; }
  ACTUAL="$(tr -d '[:space:]' <"$EXPECTED")"
  rm -f "$EXPECTED"
  http_get "$URL" "$TARGET" || return 1
  echo "Verifying the download..."
  if [[ "$(sha256sum "$TARGET" | cut -d' ' -f1)" != "$ACTUAL" ]]; then
    printf_red "The downloaded agent doesn't match its checksum ($ACTUAL). Nothing was replaced. Try again, and check the connection to the panel."
    return 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  + install gss-agent to $BIN_PATH (checksum ok, $(wc -c <"$TARGET" | tr -d ' ') bytes)"
    return 0
  fi
  chmod 0755 "$TARGET" && mv -f "$TARGET" "$BIN_PATH" || { printf_red "Couldn't install $BIN_PATH."; return 1; }
  TMP_FILE=""
}

# Enrol with the token through --token-stdin, unless CONFIG_PATH exists (then this run is an upgrade).
agent_enrol() {
  if [[ -f "$CONFIG_PATH" ]]; then
    echo "This host is already enrolled ($CONFIG_PATH); upgrading the agent only."
    return 0
  fi
  local ARGS=(enrol --panel "$PANEL_URL" --token-stdin)
  [[ "$INSECURE" == "1" ]] && ARGS+=(--insecure)
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  + printf <token> | $BIN_PATH ${ARGS[*]}"
    return 0
  fi
  echo "Enrolling this host with $PANEL_URL..."
  printf '%s\n' "$ENROL_TOKEN" | "$BIN_PATH" "${ARGS[@]}" || {
    printf_red "Enrolling failed. The token may have expired or been used already; create a new one on the panel's Hosts page."
    return 1
  }
}

# Write UNIT_PATH (same content as agent/packaging/gss-agent.service), daemon-reload, enable --now (or restart).
agent_service() {
  if [[ "$SYSTEMD_OK" != "1" ]]; then
    echo "  + skipped the systemd unit (systemd is not running)"
    return 0
  fi
  local FRESH=1
  if [[ -f "$UNIT_PATH" ]] && systemctl is-active --quiet gss-agent; then
    FRESH=0
    SERVICE_ACTIVE=1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  + write $UNIT_PATH"
  else
    cat >"$UNIT_PATH" <<'UNIT'
# systemd unit for the Ionnet GSS host agent. Installed to /etc/systemd/system/ by the install script (M5).
[Unit]
Description=Ionnet GSS host agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/gss-agent run
Restart=always
RestartSec=5
# Exit 3 = the panel revoked this host; restarting would only hammer the panel. Re-enrol instead.
RestartPreventExitStatus=3

[Install]
WantedBy=multi-user.target
UNIT
  fi
  run systemctl daemon-reload || return 1
  if [[ "$NO_START" == "1" ]]; then
    run systemctl enable gss-agent || return 1
  elif [[ "$FRESH" == "0" ]]; then
    run systemctl enable gss-agent || return 1
    run systemctl restart gss-agent || return 1
  else
    run systemctl enable --now gss-agent || return 1
  fi
}

# Read the enrol token from the terminal without echoing it (stdin may be the script itself: curl | sudo bash).
# No terminal and no GSS_ENROL_TOKEN: exit 2.
ask_token() {
  if { : </dev/tty; } 2>/dev/null; then
    printf "Enrol token: " >/dev/tty
    read -rs ENROL_TOKEN </dev/tty
    echo >/dev/tty
  fi
  ENROL_TOKEN="${ENROL_TOKEN//[[:space:]]/}"
  [[ -n "$ENROL_TOKEN" ]] || fail 2 "No enrol token and no terminal to ask on. Create a token on the panel's Hosts page and set GSS_ENROL_TOKEN in the environment (keep it with sudo -E); don't put it on the command line."
}

# The install command: every step above in order, then "Done! …" with the host's next step.
command_install() {
  check_root
  detect_distro
  detect_arch
  if [[ "$INSECURE" == "1" ]]; then
    printf_yellow "Warning: $PANEL_URL is plain http://, so this script and the agent download can be altered on the way. Only continue on a trusted network; use HTTPS for real hosts."
  fi
  if [[ ! -f "$CONFIG_PATH" && -z "$ENROL_TOKEN" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      printf_yellow "No enrol token given; a real install would ask for it here."
    else
      ask_token
    fi
  fi
  [[ "$DRY_RUN" == "1" ]] && echo "Dry run: nothing on this system is changed."
  echo "Detected $DISTRO ($(uname -m) -> $ARCH)."
  if [[ "$DRY_RUN" == "1" ]] || ! command -v docker >/dev/null 2>&1 || ! command -v nft >/dev/null 2>&1; then
    pkg_refresh || fail 1 "Couldn't refresh the package lists. Check the network and run this again."
  fi
  ensure_docker || exit 1
  ensure_nftables || exit 1
  agent_download || exit 1
  agent_enrol || exit 1
  agent_service || fail 1 "Couldn't set up the gss-agent service. Check \"systemctl status gss-agent\"."
  if [[ "$DRY_RUN" == "1" ]]; then
    printf_green "Dry run finished. Run it again without --dry-run to install."
  elif [[ "$SYSTEMD_OK" != "1" ]]; then
    printf_green "Done! The agent is installed and enrolled. Start it with: gss-agent run"
  elif [[ "$NO_START" == "1" ]]; then
    if [[ "$SERVICE_ACTIVE" == "1" ]]; then
      printf_yellow "The running gss-agent service still uses the old binary until you run: systemctl restart gss-agent"
      printf_green "Done! The new gss-agent is installed but not restarted."
    else
      printf_green "Done! Installed gss-agent. Start it with: systemctl start gss-agent"
    fi
  else
    printf_green "Done! gss-agent is running. The host shows up on the panel's Hosts page as soon as it connects."
  fi
}

# Stop and remove the unit and the binary; with --purge (asks [y/N] unless -y) also CONFIG_PATH and DATA_DIR.
command_uninstall() {
  check_root
  local PURGE_DIRS=("$(dirname "$CONFIG_PATH")" "$DATA_DIR")
  if [[ "$PURGE" == "1" && "$ASSUME_YES" != "1" && "$DRY_RUN" != "1" ]]; then
    local ANSWER=""
    echo "This also deletes ${PURGE_DIRS[0]} (the host's credential) and ${PURGE_DIRS[1]} (the game server data on this host)."
    printf "Delete them? [y/N]: "
    read -r ANSWER 2>/dev/null </dev/tty # Stdin may be the script itself (curl | bash); no terminal = no.
    echo
    [[ "$ANSWER" == "y" ]] || { echo "Nothing was removed."; return 1; }
  fi
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    run systemctl disable --now gss-agent 2>/dev/null || true
    run rm -f "$UNIT_PATH"
    run systemctl daemon-reload || true
  else
    run rm -f "$UNIT_PATH"
  fi
  run rm -f "$BIN_PATH" "$BIN_PATH.new"
  if [[ "$PURGE" == "1" ]]; then
    run rm -rf "${PURGE_DIRS[@]}"
    printf_green "Done! The agent and its data were removed. Game server containers are not removed; use \"docker ps -a\" to find them."
  else
    printf_green "Done! The agent was removed. Kept ${PURGE_DIRS[0]} and ${PURGE_DIRS[1]}; add --purge to delete them."
  fi
}

COMMAND="${1:-install}"
[[ "$COMMAND" == -* ]] && COMMAND="install" || shift
case "$COMMAND" in
  install)
    parse_flags "$@" && command_install
    exit $?
    ;;
  uninstall)
    parse_flags "$@" && command_uninstall
    exit $?
    ;;
  help)
    print_help "$@"
    exit $?
    ;;
  version)
    echo "$GSS_INSTALLER_VERSION"
    exit 0
    ;;
  *)
    printf_red "Command not found: $COMMAND"
    print_help
    exit 2
    ;;
esac
