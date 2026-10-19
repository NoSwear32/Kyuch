#!/bin/sh
# Installed as /usr/lib/kyuch/autotype-access and run as root through pkexec (see the polkit policy shipped with the package).
# Grants ("enable") or withdraws ("disable") the logged-in desktop user's access to /dev/uinput, which Kyuch's auto-type needs.
# Granting it lets EVERY program of that user type into any window, so it is only done when the user asks for it in Kyuch's Settings.
set -eu
RULE="${KYUCH_RULE_FILE:-/etc/udev/rules.d/60-kyuch-uinput.rules}"   # pkexec clears the environment, so the override only exists for tests

case "${1:-}" in
  enable)
    printf '%s\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"' > "$RULE.tmp"
    chmod 644 "$RULE.tmp"
    mv "$RULE.tmp" "$RULE" ;;
  disable)
    rm -f "$RULE" ;;
  *)
    echo "usage: autotype-access enable|disable" >&2
    exit 2 ;;
esac

udevadm control --reload 2>/dev/null || true
udevadm trigger --name-match=uinput 2>/dev/null || true
