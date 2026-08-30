#!/bin/sh
# Sample CPU of every process of one local stand (hubs, MM, relay, load lanes,
# harness) every N seconds into a log; cputime= is the cumulative CPU of the
# process, so the last sample gives the total spent per role. Usage: cpu-sampler.sh <out.log> [interval-s]
out="$1"; interval="${2:-5}"
: > "$out"
while :; do
  ts=$(date +%H:%M:%S)
  ps -Ao pid,pcpu,rss,etime,time,command | grep -E 'bun|anvil|xlnrs' | grep -v grep | grep -v cpu-sampler | \
    awk -v ts="$ts" '{
      pid=$1; cpu=$2; rss=$3; et=$4; ct=$5; $1=$2=$3=$4=$5=""; cmd=$0;
      label="other";
      if (cmd ~ /xlnrs/) label="rust-h1";
      else if (cmd ~ /load-lane-/) label="lane";
      else if (cmd ~ /hub-node/) label="hub";
      else if (cmd ~ /market-maker|mm-node/) label="mm";
      else if (cmd ~ /relay/) label="relay";
      else if (cmd ~ /anvil/) label="anvil";
      else if (cmd ~ /hlt\.ts/) label="harness";
      else if (cmd ~ /local-prod-smoke/) label="smoke";
      else if (cmd ~ /api\/server\/index\.ts/) label="server";
      else if (cmd ~ /custody/) label="custody";
      printf "%s %s pid=%s cpu=%s rssMB=%d cputime=%s\n", ts, label, pid, cpu, rss/1024, ct;
    }' >> "$out"
  echo "$ts ---" >> "$out"
  sleep "$interval"
done
