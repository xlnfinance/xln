#!/bin/sh
# Sample CPU of every process of one local stand (hubs, MM, relay, load lanes,
# harness) every N seconds into a log. Usage: cpu-sampler.sh <out.log> [interval-s]
out="$1"; interval="${2:-5}"
: > "$out"
while :; do
  ts=$(date +%H:%M:%S)
  ps -Ao pid,pcpu,rss,etime,command | grep -E 'bun|anvil' | grep -v grep | grep -v cpu-sampler | \
    awk -v ts="$ts" '{
      pid=$1; cpu=$2; rss=$3; et=$4; $1=$2=$3=$4=""; cmd=$0;
      label="other";
      if (cmd ~ /load-lane-/) label="lane";
      else if (cmd ~ /hub-node/) label="hub";
      else if (cmd ~ /market-maker|mm-node/) label="mm";
      else if (cmd ~ /relay/) label="relay";
      else if (cmd ~ /anvil/) label="anvil";
      else if (cmd ~ /hlt\.ts/) label="harness";
      else if (cmd ~ /local-prod-smoke/) label="smoke";
      else if (cmd ~ /api\/server\/index\.ts/) label="server";
      else if (cmd ~ /custody/) label="custody";
      printf "%s %s pid=%s cpu=%s rssMB=%d\n", ts, label, pid, cpu, rss/1024;
    }' >> "$out"
  echo "$ts ---" >> "$out"
  sleep "$interval"
done
