#!/bin/bash
# Removes the Inkwell battery-helper launchd agent. Leaves the deployed page and
# your videos untouched.
set -euo pipefail
LABEL="com.harshit.inkwell"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ Helper stopped and agent removed. (Deployed files left in place.)"
