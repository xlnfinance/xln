/** Real RPC forwarding fault gate: kill native H1 only after Anvil accepts its signed batch. */
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { decodeJBatch } from '../../core/jurisdiction/machine/batch';
import { safeStringify } from '../../core/protocol/serialization';

type CrashProofHealth = { systemOk?: boolean; hubMesh?: { ok: boolean }; reset?: { inProgress: boolean; completedAt: number | null; lastError: string | null } };
export const isNativeCrashProofReady = (health: CrashProofHealth): boolean =>
  health.systemOk === true && health.hubMesh?.ok === true && health.reset?.inProgress === false
  && typeof health.reset.completedAt === 'number' && health.reset.completedAt > 0 && health.reset.lastError === null;

export const startNativeJSubmitCrashProof = (port: number, upstreamPort: number, workDir: string) => {
  const upstream = `http://127.0.0.1:${upstreamPort}`;
  const provider = new ethers.JsonRpcProvider(upstream);
  const iface = Depository__factory.createInterface();
  const leasePath = join(workDir, 'prod-mesh', '.control-plane', 'hub-h1.lease.json');
  const lease = () => JSON.parse(readFileSync(leasePath, 'utf8')) as {
    pid: number; script: string; name: string; dbPath: string;
  };
  let armed: { signer: string; target: string; recipient: string } | null = null;
  let accepted: { hash: string; raw: string; pid: number; nonce: number; dbPath: string } | null = null;
  let fault: unknown;
  let recoveredOriginalHash = false;
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    async fetch(request) {
      const body = await request.text();
      const rpc = JSON.parse(body) as { method: string; params: string[] };
      if (accepted && rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === accepted.hash) {
        try { recoveredOriginalHash ||= lease().pid !== accepted.pid; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      let match = false;
      let tx: ethers.Transaction | null = null;
      if (armed && rpc.method === 'eth_sendRawTransaction') {
        tx = ethers.Transaction.from(rpc.params[0]!);
        if (tx.from?.toLowerCase() === armed.signer && tx.to?.toLowerCase() === armed.target) {
          const decoded = iface.parseTransaction({ data: tx.data });
          if (decoded?.name === 'processBatch') {
            const batch = decodeJBatch(decoded.args[0]);
            match = batch.reserveToReserve.some(op => op.receivingEntity.toLowerCase() === armed!.recipient && op.amount === 1n);
          }
        }
      }
      try {
        if (match && !accepted) {
          await provider.send('evm_setAutomine', [false]);
          await provider.send('evm_setIntervalMining', [0]);
        }
        const response = await fetch(upstream, { method: request.method, body, headers: { 'content-type': 'application/json' } });
        const text = await response.text();
        if (match) {
          seen.push(rpc.params[0]!);
          if (!accepted) {
            const result = JSON.parse(text) as { result?: string; error?: unknown };
            assert.equal(result.result, tx!.hash, `real node must accept exact signed transaction: ${text}`);
            const managed = lease();
            assert.equal(managed.script, 'rscore/target/release/xlnrs');
            assert.equal(managed.name, 'H1');
            assert.equal(managed.dbPath, join(workDir, 'prod-mesh', 'h1'));
            accepted = { hash: result.result!, raw: rpc.params[0]!, pid: managed.pid, nonce: tx!.nonce, dbPath: managed.dbPath };
            writeFileSync(join(workDir, 'native-j-accepted-before-kill.json'), safeStringify(accepted, 2));
            process.kill(managed.pid, 'SIGKILL');
            // This response is never delivered to the killed caller. The real upstream
            // accepted it; only the return transport is interrupted, not simulated.
            return new Response('native caller killed after real node acceptance', { status: 502 });
          }
        }
        return new Response(text, { status: response.status, headers: { 'content-type': 'application/json' } });
      } catch (error) {
        if (match) fault = error;
        return new Response(String(error), { status: 500 });
      }
    },
  });
  const wait = async (label: string, ready: () => Promise<boolean>) => {
    const deadline = Date.now() + 30_000;
    while (!(await ready())) {
      if (fault) throw fault;
      if (Date.now() > deadline) throw new Error(`NATIVE_J_CRASH_TIMEOUT:${label}`);
      await Bun.sleep(50);
    }
  };
  return {
    stop() { server.stop(true); provider.destroy(); },
    async prove(apiPort: number, recipient: string, orchestrationApi: string) {
      let preCrashHealth: CrashProofHealth | null = null;
      try {
        await wait('fully-bootstrapped-mesh', async () => {
          const response = await fetch(`${orchestrationApi}/api/health`);
          assert(response.ok, 'orchestration health unavailable');
          preCrashHealth = await response.json() as CrashProofHealth;
          return isNativeCrashProofReady(preCrashHealth);
        });
      } finally {
        writeFileSync(join(workDir, 'native-j-pre-crash-health.json'), safeStringify(preCrashHealth, 2));
      }
      const api = `http://127.0.0.1:${apiPort}`;
      const info = await (await fetch(`${api}/api/info`)).json() as {
        entityId: string; hubEntities: Array<{ entityId: string; signerId: string; primary: boolean }>;
      };
      const hub = info.hubEntities.find(row => row.primary);
      assert(hub, 'native primary hub identity required');
      const config = JSON.parse(readFileSync(join(workDir, 'prod-main', 'jurisdictions.json'), 'utf8')) as {
        jurisdictions: Record<string, { chainId: number; contracts: { depository: string } }>;
      };
      const jurisdiction = Object.values(config.jurisdictions).find(row => row.chainId === 31337);
      assert(jurisdiction, 'real local EVM jurisdiction required');
      const contract = Depository__factory.connect(jurisdiction.contracts.depository, provider);
      const before = { sender: await contract._reserves(hub.entityId, 1), recipient: await contract._reserves(recipient, 1), nonce: await contract.entityNonces(hub.entityId) };
      assert(before.sender >= 1n, 'native hub must own actual reserves');
      armed = { signer: hub.signerId.toLowerCase(), target: await contract.getAddress().then(x => x.toLowerCase()), recipient: recipient.toLowerCase() };
      const send = async (commandId: string, entityTxs: unknown[]) => {
        const response = await fetch(`${api}/api/control/runtime/entity-inputs`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: safeStringify({ commandId, entityInputs: [{ entityId: hub.entityId, signerId: hub.signerId, entityTxs }] }),
        });
        const result = await response.json() as { ok: boolean };
        assert(response.ok && result.ok, safeStringify(result));
      };
      await send('native-crash-r2r', [{ type: 'r2r', data: { toEntityId: recipient, tokenId: 1, amount: 1n } }]);
      // The command commits before publication. A transport close is expected if
      // publication reaches the fault gate before the HTTP acknowledgement.
      const broadcast = send('native-crash-broadcast', [{ type: 'j_broadcast', data: {} }]).catch(error => {
        if (!accepted) throw error;
      });
      await wait('accepted-before-result', async () => accepted !== null);
      await broadcast;
      const original = accepted!;
      await wait('same-db-native-restart', async () => {
        try { const next = lease(); return next.pid !== original.pid && next.dbPath === original.dbPath; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      });
      // A receipt request from the restarted native process proves it restored
      // the signed hash before the original transaction is mined.
      await wait('recovered-original-hash-before-mining', async () => recoveredOriginalHash);
      await provider.send('evm_mine', []);
      // Restore the canonical start-anvil.sh mixed-mining interval after the fault window.
      await provider.send('evm_setIntervalMining', [10]);
      await provider.send('evm_setAutomine', [true]);
      await wait('mined-original', async () => (await provider.getTransactionReceipt(original.hash))?.status === 1);
      await wait('native-recovery-ready', async () => {
        try { const response = await fetch(`${api}/api/info`); return response.ok && (await response.json()).deliveryReady === true; }
        catch { return false; }
      });
      const after = { sender: await contract._reserves(hub.entityId, 1), recipient: await contract._reserves(recipient, 1), nonce: await contract.entityNonces(hub.entityId) };
      assert.equal(after.sender, before.sender - 1n);
      assert.equal(after.recipient, before.recipient + 1n);
      assert.equal(after.nonce, before.nonce + 1n);
      const receipt = (await provider.getTransactionReceipt(original.hash))!;
      const events = await contract.queryFilter(contract.filters.HankoBatchProcessed(hub.entityId), receipt.blockNumber, 'latest');
      assert.equal(events.filter(event => event.args.nonce === after.nonce).length, 1);
      assert(seen.every(raw => raw === original.raw), 'recovery must retain identical signed wire');
      const evidence = { before, after, original, restartedPid: lease().pid, sameSignedWire: true, recoveredOriginalHashBeforeMining: recoveredOriginalHash, broadcasts: seen.length, economicEvents: 1 };
      writeFileSync(join(workDir, 'native-j-crash-proof.json'), safeStringify(evidence, 2));
      console.log(`[native-j-crash] PASS ${original.hash} one economic operation after SIGKILL`);
    },
  };
};
