#!/bin/bash
# Removes the Inkwell helper launchd agent. Leaves your project files and videos
# untouched.
set -euo pipefail
LABEL="com.harshit.inkwell"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ Helper stopped and agent removed. (Project files left in place.)"
