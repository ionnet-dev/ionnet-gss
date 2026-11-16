#!/bin/bash
########################################
# Ionnet GSS host agent install script #
########################################
# Served by the panel at /api/agent/install.sh with the two @…@ values filled in. Usage:
#   curl -fsSL https://gss.example.com/api/agent/install.sh | sudo GSS_ENROL_TOKEN=gss_enrol_… bash
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

# Print a green status line.
printf_green() {
  printf "\033[32m%s\033[0m\n" "$1"
}

# Print a red error line to stderr.
printf_red() {
  printf "\033[31m%s\033[0m\n" "$1" >&2
}

# Run a command, or only print it with --dry-run.
run() {
  # TODO(builder): M5
  return 1
}

# Print the help table.
print_help() {
  # TODO(builder): M5. Aligned table: install [--panel URL] [--insecure] [--no-start] [--dry-run], uninstall [--purge]
  # [-y], help, version; ends with 'Run "install-agent.sh help <command>" for more information on a command.'
  return 0
}

# Parse flags after the command into the globals above; unknown flags exit 2.
parse_flags() {
  # TODO(builder): M5
  return 0
}

# Require root (exit 1 with "Run this as root, e.g. with sudo.").
check_root() {
  # TODO(builder): M5
  return 1
}

# Set DISTRO to arch or debian from /etc/arch-release / /etc/debian_version, require systemd; else exit 3.
detect_distro() {
  # TODO(builder): M5
  return 1
}

# Set ARCH to amd64 or arm64 from `uname -m`; else exit 3 naming the architecture.
detect_arch() {
  # TODO(builder): M5
  return 1
}

# Install packages with pacman or apt (non-interactive).
pkg_install() {
  # TODO(builder): M5
  return 1
}

# Make sure Docker is installed, enabled and running (docker on Arch, docker.io on Debian/Ubuntu).
ensure_docker() {
  # TODO(builder): M5
  return 1
}

# Install the nftables package (the kernel tables the agent's nft helper uses), but never enable nftables.service:
# Debian's /etc/nftables.conf starts with `flush ruleset`, which would wipe Docker's and the agent's rules.
ensure_nftables() {
  # TODO(builder): M5
  return 1
}

# Download the agent for ARCH to BIN_PATH.new, verify it against /api/agent/download/linux/ARCH/sha256, rename it.
agent_download() {
  # TODO(builder): M5
  return 1
}

# Enrol with GSS_ENROL_TOKEN through --token-stdin, unless CONFIG_PATH exists (then this run is an upgrade).
agent_enrol() {
  # TODO(builder): M5
  return 1
}

# Write UNIT_PATH (same content as agent/packaging/gss-agent.service), daemon-reload, enable --now (or restart).
agent_service() {
  # TODO(builder): M5
  return 1
}

# The install command: every step above in order, then "Done! …" with the host's next step.
command_install() {
  # TODO(builder): M5
  return 1
}

# Stop and remove the unit and the binary; with --purge (asks [y/N] unless -y) also CONFIG_PATH and DATA_DIR.
command_uninstall() {
  # TODO(builder): M5
  return 1
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
    print_help
    exit 0
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
