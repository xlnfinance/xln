#!/usr/bin/env bash
# One open pull request per lane. Every pull request into development carries exactly one of the labels core, chain, spec or
# process. A core, chain or spec pull request fails while a pull request with a lower number into development, open, draft
# or not, carries the same label, so the first one opened holds the lane until it closes. process (CI and infra work) is exempt.
#   lane-label.sh check <pr-number> <open-prs.json>      exit 1 and say why when the pull request breaks the rule
#   lane-label.sh others <pr-number> <open-prs.json>     print "<number> <head branch>" of every other open pull request into
#                                                        development that carries core, chain or spec: the ones whose answer
#                                                        may have changed when this pull request was labeled, closed or reopened.
#                                                        A pull request with more than one lane label holds no lane (it is red).
# <open-prs.json> is the list of open pull requests as the GitHub API returns it (number, labels, base.ref, head.ref, state).
set -euo pipefail
readonly LANES='["core","chain","spec"]'
readonly LABELS='["core","chain","spec","process"]'

# Only open pull requests into development count, whatever the list holds.
open_into_development() { jq -c '[.[] | select(.state == "open" and .base.ref == "development")]' "$1"; }

mode="${1:?mode: check or others}"
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
    holders=$(jq -r --argjson pr "$pr" --arg lane "$lane" --argjson known "$LABELS" '[.[] | select(.number < $pr and ([.labels[].name | select(. as $l | $known | index($l))] == [$lane])) | "#\(.number)"] | join(", ")' <<<"$open")
    if [ -n "$holders" ]; then
      echo "lane-label: lane $lane is held by $holders; pull request $pr waits until it closes (re-run this check then)" >&2
      exit 1
    fi
    echo "lane-label: pull request $pr holds lane $lane"
    ;;
  others)
    pr="${2:?pull request number}"
    open=$(open_into_development "${3:?open pull requests json}")
    jq -r --argjson pr "$pr" --argjson lanes "$LANES" '.[] | select(.number != $pr and any(.labels[]; . as $l | $lanes | index($l.name))) | "\(.number) \(.head.ref)"' <<<"$open"
    ;;
  *)
    echo "lane-label: unknown mode $mode" >&2
    exit 2
    ;;
esac
