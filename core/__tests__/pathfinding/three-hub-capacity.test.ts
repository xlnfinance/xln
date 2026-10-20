import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseProfile } from '../../entity/profile';
import { buildNetworkGraph, getEdge } from '../../pathfinding/graph';
import { quoteHtlcPaymentRoute } from '../../pathfinding/htlc-quote';
import { PathFinder } from '../../pathfinding/pathfinding';

// Published profiles captured from the live local H1/H2/H3 stand on 2026-09-13.
const raw: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/pathfinding/three-hub-live-profiles.json', import.meta.url), 'utf8'),
);
if (!Array.isArray(raw)) throw new Error('THREE_HUB_PROFILE_FIXTURE_INVALID');
const profiles = raw.map(parseProfile);
const [source, recipient, h1, h2, h3] = profiles;
if (!source || !recipient || !h1 || !h2 || !h3) throw new Error('THREE_HUB_PROFILE_FIXTURE_INCOMPLETE');
const path = [source.entityId, h1.entityId, h2.entityId, h3.entityId, recipient.entityId];
const amount = 25_000_000n;
const graph = () => buildNetworkGraph(new Map(profiles.map(profile => [profile.entityId, profile])), 1);
const selected = (finder: PathFinder) =>
  finder
    .findRoutes(source.entityId, recipient.entityId, amount, 1)
    .find(route => route.path.join('/') === path.join('/'));

describe('live three-hub receive capacity boundary', () => {
  test('finds both direct-hub and three-hub paths at the exact recipient limit', () => {
    const routes = new PathFinder(graph()).findRoutes(source.entityId, recipient.entityId, amount, 1);
    expect(routes.map(route => route.path)).toContainEqual(path);
    expect(routes.map(route => route.path)).toContainEqual([
      source.entityId,
      h1.entityId,
      h3.entityId,
      recipient.entityId,
    ]);
    const route = routes.find(route => route.path.length === 5)!;
    const canonical = quoteHtlcPaymentRoute(profiles, route.path, 1, amount);
    expect(route.totalAmount).toBe(canonical.senderLockAmount);
    expect(route.totalAmount).toBe(25_000_075n);
    expect(route.totalFee).toBe(75n);
    expect(route.hops.map(hop => hop.fee)).toEqual([0n, 25n, 25n, 25n]);
  });

  test('rejects one unit above the receiving limit', () => {
    expect(new PathFinder(graph()).findRoutes(source.entityId, recipient.entityId, amount + 1n, 1)).toEqual([]);
  });

  test('checks the exact debit on each Account, including upstream forwarding fees', () => {
    const network = graph();
    const edge = getEdge(network, h2.entityId, h3.entityId, 1)!;
    edge.capacity = 25_000_025n;
    expect(selected(new PathFinder(network))).toBeDefined();
    edge.capacity -= 1n;
    expect(selected(new PathFinder(network))).toBeUndefined();
  });

  test('funding quotes waive only the selected first Account', () => {
    const network = graph();
    getEdge(network, source.entityId, h1.entityId, 1)!.capacity = 0n;
    expect(new PathFinder(network).findRoutes(source.entityId, recipient.entityId, amount, 1)).toEqual([]);
    expect(
      new PathFinder(network)
        .findRoutes(source.entityId, recipient.entityId, amount, 1, 100, h1.entityId)
        .map(route => route.path),
    ).toContainEqual(path);
    getEdge(network, h3.entityId, recipient.entityId, 1)!.capacity = amount - 1n;
    expect(
      new PathFinder(network).findRoutes(source.entityId, recipient.entityId, amount, 1, 100, h1.entityId),
    ).toEqual([]);
  });

  test('quotes a self-payment only through unique intermediate Accounts with exact canonical fees', () => {
    const selfPath = [h1.entityId, h2.entityId, h3.entityId, h1.entityId];
    const routes = new PathFinder(graph()).findRoutes(h1.entityId, h1.entityId, amount, 1);
    const route = routes.find(value => value.path.join('/') === selfPath.join('/'));
    expect(route).toBeDefined();
    const canonical = quoteHtlcPaymentRoute(profiles, selfPath, 1, amount);
    expect(route!.totalAmount).toBe(canonical.senderLockAmount);
    expect(route!.totalFee).toBe(canonical.senderLockAmount - amount);
    for (const value of routes) {
      expect(value.path.length).toBeGreaterThanOrEqual(4);
      expect(value.path[0]).toBe(value.path.at(-1));
      expect(new Set(value.path.slice(0, -1)).size).toBe(value.path.length - 1);
    }
    // The user has only one Account: returning over it is not a privacy cycle.
    expect(new PathFinder(graph()).findRoutes(source.entityId, source.entityId, amount, 1)).toEqual([]);
  });

  test('self-payment retains exact capacity checks on every Account, including the return hop', () => {
    const network = graph();
    const selfPath = [h1.entityId, h2.entityId, h3.entityId, h1.entityId];
    const find = () =>
      new PathFinder(network)
        .findRoutes(h1.entityId, h1.entityId, amount, 1)
        .find(value => value.path.join('/') === selfPath.join('/'));
    const route = find();
    expect(route).toBeDefined();
    let required = route!.totalAmount;
    for (const hop of route!.hops) {
      required -= hop.fee;
      const edge = getEdge(network, hop.from, hop.to, 1)!;
      const previous = edge.capacity;
      edge.capacity = required;
      expect(find()).toBeDefined();
      edge.capacity -= 1n;
      expect(find()).toBeUndefined();
      edge.capacity = previous;
    }
  });
});
