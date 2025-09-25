# Flush/Update Protocol

This protocol defines state channel transitions, how they are sent between the parties (currently all channels are bidirectional and limited to 2 parties) and how the transitions are applied.

## Flush

## Update

## Merge (conflict resolution)

Sometimes it might happen two parties are flushing changes to each other at the same time, which would lead to a dead lock. Therefore we propose a merging process (similar to auto-resolutions in Git when there are new changes in the master to rebase on).
