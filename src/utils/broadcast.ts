/**
 * Multi-source transaction broadcast.
 *
 * Broadcast order (best to last-resort):
 *
 *   1. Anvil-Mesh — configured via localStorage keys `anvil_node_url` +
 *      `anvil_auth_token`. Sends BEEF to POST /broadcast?arc=true.
 *      Primary path when configured; skipped if not.
 *   2. spv-store (oneSatSPV.broadcast) — the wallet's existing broadcast
 *      path. Internally routes through ARC/TAAL/WoC depending on config.
 *   3. WhatsOnChain direct — last-resort, just posts the raw hex.
 *
 * Returns the same shape as oneSatSPV.broadcast so call sites only need
 * a minimal edit: `{ status: 'success' | 'error', description: string }`.
 *
 * Rationale: the wallet red-line says minimal changes, and broadcast
 * redundancy is exactly the kind of SPF-hardening that passes the
 * BRC-100 litmus test ("any wallet broadcasting txs needs this"). Per-
 * federation-node auth token lives in localStorage — same pattern the
 * DEX uses for anvil_node_url today.
 *
 * 2026-04-17 wallet re-fork patch 6/6.
 */

import type { Transaction } from '@bsv/sdk';
import type { SPVStore } from 'spv-store';
import { getMeshBroadcastHealth } from './meshHealth';

export interface BroadcastResult {
  status: 'success' | 'error';
  description: string;
  txid?: string;
}

interface MeshBroadcastResponse {
  txid?: string;
  status?: 'propagated' | 'queued' | 'rejected' | 'validated-only';
  confidence?: string;
  message?: string;
}

async function broadcastViaMesh(tx: Transaction): Promise<BroadcastResult | null> {
  const nodeUrl = (typeof localStorage !== 'undefined' && localStorage.getItem('anvil_node_url')) || '';
  const authToken = (typeof localStorage !== 'undefined' && localStorage.getItem('anvil_auth_token')) || '';
  if (!nodeUrl || !authToken) return null; // not configured → skip silently

  // Pre-flight health check: if the Mesh node reports its own broadcast
  // upstream as "down", skip this path rather than waste a ~5s round-trip
  // on a known-bad node. 30s cache means this is cheap per-broadcast.
  const health = await getMeshBroadcastHealth();
  if (health === 'down') {
    return { status: 'error', description: 'anvil-mesh self-reports broadcast upstream down' };
  }
  try {
    // Anvil-Mesh /broadcast takes raw BEEF bytes as application/octet-stream.
    // tx.toBEEF() yields a number[] that we send as binary.
    const beef = tx.toBEEF();
    const res = await fetch(`${nodeUrl.replace(/\/$/, '')}/broadcast?arc=true`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(beef),
    });
    if (!res.ok) {
      return { status: 'error', description: `anvil-mesh http ${res.status}` };
    }
    const data = (await res.json()) as MeshBroadcastResponse;
    // Treat propagated OR queued as success. validated-only means Anvil
    // stored the BEEF but ARC didn't confirm receipt — fall through so
    // the next broadcast path gets a chance.
    if (data.status === 'propagated' || data.status === 'queued') {
      return { status: 'success', description: 'broadcast via anvil-mesh', txid: data.txid };
    }
    if (data.status === 'rejected') {
      return { status: 'error', description: `anvil-mesh rejected: ${data.message || 'no reason'}` };
    }
    return { status: 'error', description: `anvil-mesh status ${data.status || 'unknown'}` };
  } catch (err) {
    return { status: 'error', description: `anvil-mesh threw: ${(err as Error).message}` };
  }
}

async function broadcastViaWocDirect(tx: Transaction): Promise<BroadcastResult | null> {
  try {
    const rawHex = tx.toHex();
    const res = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawHex }),
    });
    const text = (await res.text()).trim();
    if (!res.ok) return { status: 'error', description: `woc http ${res.status}: ${text}` };
    const txid = text.replace(/^"|"$/g, '');
    return { status: 'success', description: 'broadcast via woc-direct', txid };
  } catch (err) {
    return { status: 'error', description: `woc-direct threw: ${(err as Error).message}` };
  }
}

export async function broadcastMultiSource(
  tx: Transaction,
  opts: { oneSatSPV: SPVStore },
): Promise<BroadcastResult> {
  // 1. Anvil-Mesh (if configured)
  const meshResult = await broadcastViaMesh(tx);
  if (meshResult && meshResult.status === 'success') {
    console.log(`[broadcast] ${meshResult.description} — ${meshResult.txid}`);
    return meshResult;
  }
  if (meshResult) {
    console.warn(`[broadcast] anvil-mesh failed: ${meshResult.description} — falling back to spv-store`);
  }

  // 2. spv-store (the wallet's existing broadcast with its own internal fallback chain)
  // When spv-store is sync-degraded (ordinals.1sat.app outage), its
  // broadcast call can hang indefinitely — internally awaits queues
  // that never fire. A silent try/catch doesn't save us from a
  // promise that never resolves. Race against a 10s timeout so the
  // tx always reaches the woc-direct fallback within human-scale
  // time instead of leaving the UI spinner forever.
  const SPV_BROADCAST_TIMEOUT_MS = 10_000;
  try {
    const spvPromise = opts.oneSatSPV.broadcast(tx);
    const timeoutPromise = new Promise<'__timeout__'>((resolve) =>
      setTimeout(() => resolve('__timeout__'), SPV_BROADCAST_TIMEOUT_MS),
    );
    const raced = await Promise.race([spvPromise, timeoutPromise]);
    if (raced === '__timeout__') {
      console.warn(
        `[broadcast] spv-store hung for ${SPV_BROADCAST_TIMEOUT_MS}ms — falling back to woc-direct`,
      );
    } else {
      const spvResult = raced as { status?: string; description?: string };
      if (spvResult.status !== 'error') {
        const txid = tx.id('hex') as string;
        console.log(`[broadcast] via spv-store — ${txid}`);
        return { status: 'success', description: 'broadcast via spv-store', txid };
      }
      console.warn(`[broadcast] spv-store failed: ${spvResult.description} — falling back to woc-direct`);
    }
  } catch (err) {
    console.warn(`[broadcast] spv-store threw: ${(err as Error).message} — falling back to woc-direct`);
  }

  // 3. WhatsOnChain direct (last-resort)
  const wocResult = await broadcastViaWocDirect(tx);
  if (wocResult && wocResult.status === 'success') {
    console.log(`[broadcast] ${wocResult.description} — ${wocResult.txid}`);
    return wocResult;
  }

  const chain = [
    meshResult?.description || 'anvil-mesh not configured',
    'spv-store failed',
    wocResult?.description || 'woc-direct failed',
  ].join(' → ');
  return { status: 'error', description: `all broadcast paths failed (${chain})` };
}
