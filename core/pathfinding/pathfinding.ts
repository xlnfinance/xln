/**
 * Dijkstra Pathfinding Implementation for Payment Routing
 * Finds optimal payment routes through the network
 */

import type { NetworkGraph, AccountEdge } from './graph';
import { getEdge } from './graph';
import { calculateRequiredInboundForDesiredForward } from '../protocol/htlc/utils';

export interface PaymentRoute {
  path: string[]; // Array of entity IDs from source to target
  hops: Array<{
    from: string;
    to: string;
    fee: bigint;
    feePPM: number;
  }>;
  totalFee: bigint;
  totalAmount: bigint; // Amount including fees
  probability: number; // Success probability estimate (0-1)
}

/**
 * Priority queue entry for Dijkstra
 */
interface QueueEntry {
  cost: bigint;
  node: string;
  path: string[];
  totalFee: bigint;
}

export class PathFinder {
  constructor(private graph: NetworkGraph) {}

  /**
   * Find payment routes using modified Dijkstra algorithm
   * Returns up to maxRoutes sorted by total fees
   */
  findRoutes(
    source: string,
    target: string,
    amount: bigint,
    tokenId: number,
    maxRoutes: number = 100,
    fundingAccountId?: string,
  ): PaymentRoute[] {
    const isSelfRoute = source === target;
    if (!this.graph.nodes.has(source) || !this.graph.nodes.has(target)) return [];

    const routes: PaymentRoute[] = [];
    // Distinct loop-free prefixes can have different capacity outcomes. Keep
    // them until the complete route is checked; bound total search work.
    const MAX_PATHFINDER_POPS = 4_096;
    let pops = 0;

    // Priority queue: [cost, node, path, totalFee]
    const queue: QueueEntry[] = [
      {
        cost: 0n,
        node: source,
        path: [source],
        totalFee: 0n,
      },
    ];

    while (queue.length > 0 && routes.length < maxRoutes) {
      pops += 1;
      if (pops > MAX_PATHFINDER_POPS) break;
      // Sort by cost (simple priority queue)
      queue.sort((a, b) => {
        if (a.cost < b.cost) return -1;
        if (a.cost > b.cost) return 1;
        return 0;
      });

      const current = queue.shift()!;

      // Found target - build route
      if (current.node === target && current.path.length > 1) {
        const route = this.buildRoute(current.path, amount, tokenId);
        if (route && this.capacityFits(route, tokenId, Boolean(fundingAccountId))) {
          routes.push(route);
        }
        continue;
      }

      // Explore neighbors
      const edges = this.graph.edges.get(current.node) ?? []; // Explicit undefined handling
      for (const edge of edges) {
        // Funding is a read-only quote for one existing first Account. It never
        // grants credit or permits an alternative first hop to escape admission.
        if (current.node === source && fundingAccountId && edge.to !== fundingAccountId) continue;
        // Skip if wrong token or disabled
        if (edge.tokenId !== tokenId || edge.disabled) continue;

        // The HTLC envelope permits self-pay only with two or more unique
        // intermediates. Close that cycle once; never repeat an intermediate
        // or advertise a zero-hop / same-Account round trip as a payment.
        const closesSelfRoute = isSelfRoute && edge.to === target && current.path.length >= 3;
        if (current.path.includes(edge.to) && !closesSelfRoute) continue;

        // Recipient principal is a lower bound for every edge. Exact fees are
        // checked on the completed route, on the Account that actually locks them.
        if (!(current.node === source && fundingAccountId) && amount > edge.capacity) continue;
        const prefix = this.buildRoute([...current.path, edge.to], amount, tokenId);
        if (!prefix) continue;
        const newTotalFee = prefix.totalFee;

        // Add to queue with updated cost
        queue.push({
          cost: newTotalFee, // Use total fee as cost
          node: edge.to,
          path: [...current.path, edge.to],
          totalFee: newTotalFee,
        });
      }
    }

    // Sort routes by total fee
    return routes.sort((a, b) => {
      if (a.totalFee < b.totalFee) return -1;
      if (a.totalFee > b.totalFee) return 1;
      return 0;
    });
  }

  private capacityFits(route: PaymentRoute, tokenId: number, fundingFirstAccount: boolean): boolean {
    let required = route.totalAmount;
    for (const [index, hop] of route.hops.entries()) {
      // The current forwarder retains its fee before locking on its outgoing
      // Account. Charging it to that Account rejects an exact-capacity receiver.
      required -= hop.fee;
      const edge = getEdge(this.graph, hop.from, hop.to, tokenId);
      if (!edge || (!(index === 0 && fundingFirstAccount) && required > edge.capacity)) return false;
    }
    return true;
  }

  private buildRoute(path: string[], amount: bigint, tokenId: number): PaymentRoute | null {
    if (path.length < 2) return null;
    const edges: AccountEdge[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const edge = getEdge(this.graph, path[i]!, path[i + 1]!, tokenId);
      if (!edge || !Number.isInteger(edge.feePPM) || edge.feePPM < 0 || edge.feePPM >= 1_000_000) return null;
      edges.push(edge);
    }
    const amounts = new Array<bigint>(edges.length).fill(amount);
    // Same fee inversion and intermediary ownership as quoteHtlcPaymentRoute.
    // The sender does not pay itself a routing fee; the last Account locks
    // exactly the recipient amount, with its hub's fee on the preceding Account.
    for (let i = edges.length - 1; i >= 1; i--) {
      const edge = edges[i]!;
      amounts[i - 1] = calculateRequiredInboundForDesiredForward(amounts[i]!, edge.feePPM, edge.baseFee);
    }
    const hops = edges.map((edge, i) => ({
      from: edge.from,
      to: edge.to,
      fee: i === 0 ? 0n : amounts[i - 1]! - amounts[i]!,
      feePPM: edge.feePPM,
    }));
    const probability = edges.reduce(
      (value, edge, i) =>
        edge.capacity > 0n ? value * Math.exp((-2 * Number(amounts[i]!)) / Number(edge.capacity)) : value,
      1,
    );
    return {
      path,
      hops,
      totalFee: amounts[0]! - amount,
      totalAmount: amounts[0]!,
      probability: Math.max(0.01, Math.min(1, probability)),
    };
  }
}
