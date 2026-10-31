#!/usr/bin/env bash
# Hide the mouse pointer on the kiosk display.
#
# styles.css handles `cursor: none` inside the dashboard page; this covers
# everything Chrome's CSS cannot: the X root/desktop cursor, boot-time error
# pages, and the moment before CSS paints. Safe to re-run; run as the display
# user. Applies immediately when $DISPLAY is set and at every labwc session
# start via ~/.config/labwc/autostart.
set -euo pipefail

CONF_DIR="$HOME/.config/homedashboard"
AUTOSTART="$HOME/.config/labwc/autostart"
mkdir -p "$CONF_DIR" "$(dirname "$AUTOSTART")"

cat > "$CONF_DIR/blank.xbm" <<'EOF'
#define blank_width 1
#define blank_height 1
#define blank_x_hot 0
#define blank_y_hot 0
static char blank_bits[] = {
   0x00};
EOF
cat > "$CONF_DIR/blank_mask.xbm" <<'EOF'
#define blank_mask_width 1
#define blank_mask_height 1
static char blank_mask_bits[] = {
   0x00};
EOF

if [ ! -f "$AUTOSTART" ]; then
  printf '#!/bin/sh\n' > "$AUTOSTART"
  chmod +x "$AUTOSTART"
fi
if ! grep -q 'homedashboard/blank.xbm' "$AUTOSTART"; then
  # Absolute paths, one plain command per line: labwc's autostart parser is
  # not a full shell, so no $HOME, && or backgrounding in here.
  printf 'xsetroot -cursor %s/blank.xbm %s/blank_mask.xbm\n' "$CONF_DIR" "$CONF_DIR" >> "$AUTOSTART"
  if command -v unclutter >/dev/null; then
    printf '%s -idle 2 -root\n' "$(command -v unclutter)" >> "$AUTOSTART"
  fi
fi

if [ -n "${DISPLAY:-}" ] && command -v xsetroot >/dev/null; then
  xsetroot -cursor "$CONF_DIR/blank.xbm" "$CONF_DIR/blank_mask.xbm" || true
  if command -v unclutter >/dev/null && ! pgrep -x unclutter >/dev/null; then
    setsid nohup unclutter -idle 2 -root >/dev/null 2>&1 < /dev/null &
  fi
fi

echo "Mouse cursor hidden (root cursor blanked + idle unclutter; session-autostart configured)."
