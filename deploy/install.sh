#!/usr/bin/env bash
# Installs HomeDashboard on this machine (designed for Raspberry Pi OS, works
# on any Linux with systemd + Node 20+ + Chrome/Chromium).
#
# Usage:  sudo ./deploy/install.sh [source-dir]
#   source-dir defaults to the repository root (parent of deploy/).
set -euo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR=/opt/homedashboard
ENV_FILE=/etc/homedashboard/env
SYSTEMD_DIR=/etc/systemd/system

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo ./deploy/install.sh)" >&2
  exit 1
fi

# The human user the services should run as (root when invoked via sudo).
USER_NAME="$(logname 2>/dev/null || echo pi)"
echo "Installing HomeDashboard for user: $USER_NAME"

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js >= 20 first." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required (found $(node --version))." >&2
  exit 1
fi

CHROME="$(command -v google-chrome || command -v chromium || true)"
if [ -z "$CHROME" ]; then
  echo "ERROR: no browser found. Install one first, e.g.:" >&2
  echo "  sudo apt install chromium        (Raspberry Pi OS / Debian)" >&2
  exit 1
fi
echo "Using browser: $CHROME"

# --- 1. Copy application files ---------------------------------------------
mkdir -p "$INSTALL_DIR"
tar -C "$SRC" \
  --exclude='.git' --exclude='dev' --exclude='test' \
  --exclude='config.json' --exclude='cache' --exclude='node_modules' \
  -cf - . | tar -C "$INSTALL_DIR" -xf -
# scripts/ ships too: kiosk-watchdog.mjs runs from $INSTALL_DIR.

# --- 2. Configuration (never clobber an existing one) -----------------------
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  cp "$SRC/config.example.json" "$INSTALL_DIR/config.json"
  echo "Created $INSTALL_DIR/config.json from example — EDIT IT."
else
  echo "Keeping existing $INSTALL_DIR/config.json"
fi

# --- 3. Secrets file (never clobber an existing one) ------------------------
mkdir -p /etc/homedashboard
if [ ! -f "$ENV_FILE" ]; then
  printf '# HomeDashboard secrets — loaded by the systemd service.\nOPENWEATHERMAP_API_KEY=\n' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown "$USER_NAME" "$USER_NAME" "$ENV_FILE"
  echo "Created $ENV_FILE (mode 600) — put your API key in it."
fi

# --- 4. systemd units --------------------------------------------------------
sed -e "s/__USER__/$USER_NAME/g" \
    "$SRC/deploy/homedashboard.service" > "$SYSTEMD_DIR/homedashboard.service"
sed -e "s/__USER__/$USER_NAME/g" -e "s|__CHROME__|$CHROME|" \
    "$SRC/deploy/homedashboard-display.service" > "$SYSTEMD_DIR/homedashboard-display.service"
sed -e "s/__USER__/$USER_NAME/g" \
    "$SRC/deploy/homedashboard-watchdog.service" > "$SYSTEMD_DIR/homedashboard-watchdog.service"

systemctl daemon-reload
systemctl enable --now homedashboard.service
systemctl enable --now homedashboard-display.service
systemctl enable --now homedashboard-watchdog.service

echo
echo "Installed. Next steps:"
echo "  1. Edit $INSTALL_DIR/config.json   (photo dir, location, calendar feed)"
if [ -f "$ENV_FILE" ]; then
  echo "  2. Put your OpenWeatherMap key in $ENV_FILE"
fi
echo "  3. Set the timezone if needed:  sudo timedatectl set-timezone <Zone>"
echo "  4. Restart after editing:       sudo systemctl restart homedashboard"
echo "  Status:  systemctl status homedashboard homedashboard-display"
echo "  Logs:    journalctl -u homedashboard -f"
