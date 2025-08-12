#!/bin/zsh

# Usage:
#   scripts/notify.sh "Message" "Title" "Subtitle" "Ping"
# Defaults:
#   Title: XLN Agent
#   Subtitle: 
#   Sound: Ping

MSG=${1:-"XLN notification"}
TITLE=${2:-"XLN Agent"}
SUBTITLE=${3:-""}
SOUND=${4:-"Ping"}

osascript -e "display notification \"$MSG\" with title \"$TITLE\" subtitle \"$SUBTITLE\" sound name \"$SOUND\""


