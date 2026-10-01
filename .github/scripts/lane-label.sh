#!/usr/bin/env bash
# One open pull request per lane. Every pull request into development carries exactly one of the labels core, chain, spec or
# process. A core, chain or spec pull request fails while a pull request with a lower number into development, open, draft
# or not, carries the same label, so the first one opened holds the lane until it closes. process (CI and infra work) is exempt.
#   lane-label.sh check <pr-number> <open-prs.json>      exit 1 and say why when the pull request breaks the rule
#   lane-label.sh waiting <event.json> <open-prs.json>   after a pull request closes, print "<number> <head branch>" of each
#                                                        open pull request that carries the lane it held (core, chain or spec)
# <open-prs.json> is the list of open pull requests as the GitHub API returns it (number, labels, base.ref, head.ref, state).
set -euo pipefail
readonly LANES='["core","chain","spec"]'
readonly LABELS='["core","chain","spec","process"]'

# Only open pull requests into development count, whatever the list holds.
open_into_development() { jq -c '[.[] | select(.state == "open" and .base.ref == "development")]' "$1"; }

mode="${1:?mode: check or waiting}"
case "$mode" in
  check)
    pr="${2:?pull request number}"
    open=$(open_into_development "${3:?open pull requests json}")
    labels=$(jq -c --argjson pr "$pr" --argjson known "$LABELS" '[.[] | select(.number == $pr) | .labels[].name | select(. as $l | $known | index($l))]' <<<"$open")
    if ! jq -e --argjson pr "$pr" 'any(.[]; .number == $pr)' <<<"$open" >/dev/null; then
      echo "lane-label: pull request $pr is not among the open pull requests into development" >&2
      exit 1
    fi
    count=$(jq 'length' <<<"$labels")
    if [ "$count" -ne 1 ]; then
      echo "lane-label: pull request $pr must carry exactly one of core, chain, spec, process; it carries $count ($(jq -r 'join(", ")' <<<"$labels"))" >&2
      exit 1
    fi
    lane=$(jq -r '.[0]' <<<"$labels")
    if [ "$lane" = "process" ]; then
      echo "lane-label: pull request $pr is process, exempt"
      exit 0
    fi
    holders=$(jq -r --argjson pr "$pr" --arg lane "$lane" '[.[] | select(.number < $pr and any(.labels[]; .name == $lane)) | "#\(.number)"] | join(", ")' <<<"$open")
    if [ -n "$holders" ]; then
      echo "lane-label: lane $lane is held by $holders; pull request $pr waits until it closes (re-run this check then)" >&2
      exit 1
    fi
    echo "lane-label: pull request $pr holds lane $lane"
    ;;
  waiting)
    event="${2:?event json}"
    open=$(open_into_development "${3:?open pull requests json}")
    closed=$(jq -r '.pull_request.number' "$event")
    lane=$(jq -r --argjson lanes "$LANES" '[.pull_request.labels[].name | select(. as $l | $lanes | index($l))][0] // empty' "$event")
    [ -z "$lane" ] && exit 0
    jq -r --argjson closed "$closed" --arg lane "$lane" '.[] | select(.number != $closed and any(.labels[]; .name == $lane)) | "\(.number) \(.head.ref)"' <<<"$open"
    ;;
  *)
    echo "lane-label: unknown mode $mode" >&2
    exit 2
    ;;
esac
