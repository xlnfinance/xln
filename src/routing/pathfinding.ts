/**
 * Dijkstra Pathfinding Implementation for Payment Routing
 * Finds optimal payment routes through the network
 */

import type { NetworkGraph, ChannelEdge } from './graph';
import { getEdge } from './graph';

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
    maxRoutes: number = 100
  ): PaymentRoute[] {
    if (source === target) return [];
    if (!this.graph.nodes.has(source) || !this.graph.nodes.has(target)) return [];

    const routes: PaymentRoute[] = [];
    const visited = new Map<string, Set<string>>(); // node -> set of previous nodes

    // Priority queue: [cost, node, path, totalFee]
    const queue: QueueEntry[] = [{
      cost: 0n,
      node: source,
      path: [source],
      totalFee: 0n,
    }];

    while (queue.length > 0 && routes.length < maxRoutes) {
      // Sort by cost (simple priority queue)
      queue.sort((a, b) => {
        if (a.cost < b.cost) return -1;
        if (a.cost > b.cost) return 1;
        return 0;
      });

      const current = queue.shift()!;

      // Check if we've visited this node from this previous node
      const prevNode = current.path[current.path.length - 2] || 'START';
      const visitedFrom = visited.get(current.node) || new Set();
      if (visitedFrom.has(prevNode)) continue;
      visitedFrom.add(prevNode);
      visited.set(current.node, visitedFrom);

      // Found target - build route
      if (current.node === target) {
        const route = this.buildRoute(current.path, amount, tokenId);
        if (route) {
          routes.push(route);
        }
        continue;
      }

      // Explore neighbors
      const edges = this.graph.edges.get(current.node) ?? []; // Explicit undefined handling
      for (const edge of edges) {
        // Skip if wrong token or disabled
        if (edge.tokenId !== tokenId || edge.disabled) continue;

        // Skip if already in path (no loops)
        if (current.path.includes(edge.to)) continue;

        // Calculate required amount at this hop (working backwards)
        const requiredAmount = this.calculateRequiredAmount(
          amount,
          [...current.path, edge.to],
          target,
          tokenId
        );

        // Skip if insufficient capacity
        if (requiredAmount > edge.capacity) continue;

        // Calculate fee for this edge
        const edgeFee = this.calculateFee(edge, requiredAmount);
        const newTotalFee = current.totalFee + edgeFee;

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

  /**
   * Calculate fee for an edge
   */
  private calculateFee(edge: ChannelEdge, amount: bigint): bigint {
    // Fee = baseFee + (amount * feePPM / 1,000,000)
    const proportionalFee = (amount * BigInt(edge.feePPM)) / 1_000_000n;
    return edge.baseFee + proportionalFee;
  }

  /**
   * Calculate required amount at each hop (working backwards from target)
   */
  private calculateRequiredAmount(
    finalAmount: bigint,
    path: string[],
    target: string,
    tokenId: number
  ): bigint {
    let amount = finalAmount;

    // Work backwards from target to source
    for (let i = path.length - 1; i > 0; i--) {
      if (path[i] === target) continue; // Skip target node

      const edge = getEdge(this.graph, path[i - 1]!, path[i]!, tokenId);
      if (edge) {
        // Add fee that this hop will charge
        amount = amount + this.calculateFee(edge, amount);
      }
    }

    return amount;
  }

  /**
   * Build complete route details from path
   */
  private buildRoute(
    path: string[],
    amount: bigint,
    tokenId: number
  ): PaymentRoute | null {
    if (path.length < 2) return null;

    const hops: PaymentRoute['hops'] = [];
    let totalFee = 0n;
    let currentAmount = amount;

    // Build hops forward, calculating fees
    for (let i = 0; i < path.length - 1; i++) {
      const edge = getEdge(this.graph, path[i]!, path[i + 1]!, tokenId);
      if (!edge) return null;

      const fee = this.calculateFee(edge, currentAmount);
      hops.push({
        from: path[i]!,
        to: path[i + 1]!,
        fee,
        feePPM: edge.feePPM,
      });

      totalFee += fee;
      currentAmount += fee; // Next hop needs more to cover this fee
    }

    // Calculate success probability
    const probability = this.calculateProbability(path, amount, tokenId);

    return {
      path,
      hops,
      totalFee,
      totalAmount: amount + totalFee,
      probability,
    };
  }

  /**
   * Calculate success probability based on channel utilization
   */
  private calculateProbability(
    path: string[],
    amount: bigint,
    tokenId: number
  ): number {
    let probability = 1.0;

    for (let i = 0; i < path.length - 1; i++) {
      const edge = getEdge(this.graph, path[i]!, path[i + 1]!, tokenId);
      if (edge && edge.capacity > 0n) {
        const utilization = Number(amount) / Number(edge.capacity);
        // Higher utilization = lower success probability
        // Using exponential decay: e^(-2 * utilization)
        probability *= Math.exp(-2 * utilization);
      }
    }

    return Math.max(0.01, Math.min(1.0, probability));
  }
}