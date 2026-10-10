import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
const base = new URL('../temp/real/', import.meta.url);
const guardRoot = process.env.GUARD_PACKAGE
  ? new URL('file:///' + process.env.GUARD_PACKAGE.replaceAll('\\', '/').replace(/\/$/, '') + '/')
  : new URL('../plugin/', import.meta.url);
const asar = process.env.DSH_ASAR ?? 'E:/dsh/resources/app.asar';
const extractor = fileURLToPath(new URL('./asar_extract.js', import.meta.url));
for (const [folder, paths] of [
  ['real', ['/dsh/node_modules/@deepseek-ai/cordis/lib/index.js', '/dsh/node_modules/@deepseek-ai/cosmokit/lib/index.js']],
  ['typert', ['/dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js']],
  ['protocol', ['/dsh/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js']],
  ['runtime', ['/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js', '/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js']],
  ['adapter', ['/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js']],
]) {
  if (process.env.DSH_RUNTIME_DIRECTORY) {
    const destination = new URL(`../temp/${folder}/`, import.meta.url);
    await mkdir(destination, { recursive: true });
    for (const path of paths) {
      const relative = path.replace('/dsh/node_modules/', '');
      const filename = relative.replace('@deepseek-ai/', '').replaceAll('/', '__');
      await writeFile(new URL(filename, destination), await readFile(join(process.env.DSH_RUNTIME_DIRECTORY, 'node_modules', relative)));
    }
  } else {
  execFileSync(process.execPath, [extractor, asar, paths.join(','), fileURLToPath(new URL(`../temp/${folder}/`, import.meta.url))], { stdio: 'pipe' });
  }
}
await writeFile(new URL('cordis.mjs', base), (await readFile(new URL('cordis__lib__index.js', base), 'utf8')).replace('@deepseek-ai/cosmokit', './cosmo.mjs'));
await writeFile(new URL('cosmo.mjs', base), await readFile(new URL('cosmokit__lib__index.js', base)));
const cordis = await import(new URL('cordis.mjs', base));
await writeFile(new URL('registry.mjs', base), (await readFile(new URL('../typert/dsh-typert-registry__lib__index.js', base), 'utf8')).replace('@deepseek-ai/cordis', './cordis.mjs').replace('import { z } from "zod";', 'const z = {};'));
const { TypertRegistry } = await import(new URL('registry.mjs', base));
await writeFile(new URL('protocol.mjs', base), (await readFile(new URL('../protocol/dsh-typert-protocol__lib__index.js', base), 'utf8')).replace('@deepseek-ai/cordis', './cordis.mjs'));
let hostSource = await readFile(new URL('../runtime/dsh-api-gateway__lib__index.js', base), 'utf8');
hostSource = hostSource.replace('@deepseek-ai/cordis', './cordis.mjs').replace('@deepseek-ai/dsh-typert-protocol', './protocol.mjs')
  .replace('import { OperatorPeer } from "@deepseek-ai/dsh-client-connection";', 'const OperatorPeer = value => value;')
  .replace('import { Deque } from "@deepseek-ai/dsh-deque";', 'class Deque {}')
  .replace('import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";', 'const MAX_TIMER_DELAY_MS = 2147483647;')
  .replace('import z from "@deepseek-ai/schemastery";', '')
  .replace('import WebSocket, { WebSocketServer } from "ws";', 'class WebSocket {} class WebSocketServer {}')
  .replace(/static Config = z\.object\([\s\S]*?\n\t\}\);/, 'static Config = undefined;');
await writeFile(new URL('host-gateway.mjs', base), hostSource);
const { TypertGatewayService } = await import(new URL('host-gateway.mjs', base));
const guardPlugin = await import(new URL('index.js', guardRoot));
const adapterSource = await readFile(new URL('../adapter/dsh-llm-pi-ai__lib__index.js', base), 'utf8');
const mapUsageMatch = adapterSource.match(/function mapUsage\(usage\) \{[\s\S]*?\n\}/);
assert.ok(mapUsageMatch, 'installed DSH adapter must retain its usage mapper');
const mapUsage = runInNewContext(`(${mapUsageMatch[0]})`);
const mappedUsage = JSON.parse(JSON.stringify(mapUsage({ input: 12, output: 34, totalTokens: 156, cacheRead: 100, cacheWrite: 10 })));
assert.deepEqual(mappedUsage, {
  inputTokens: 12, outputTokens: 34, totalTokens: 156,
  cacheReadTokens: 100, cacheWriteTokens: 10,
}, 'real DSH adapter must forward the same split usage shown by DSH');
const { normalizeUsage } = await import(new URL('lib/usage.js', guardRoot));
const normalizedUsage = normalizeUsage(mappedUsage);
for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
  assert.equal(normalizedUsage[key], mappedUsage[key], `Guard must preserve ${key}`);
}
console.log('PASS: actual DSH pi-ai usage mapper -> Guard preserves input/output/cacheRead/cacheWrite/total');
const testHome = await mkdtemp(join(tmpdir(), 'guard-real-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = testHome;
// Optional genuine Core acquired separately for local development; never shipped.
let verifyLive2d = false;
try {
  const core = await readFile(new URL('../temp/live2dcubismcore.min.js', import.meta.url));
  await mkdir(join(testHome, 'ustc-guard/live2d-cache'), { recursive: true });
  await writeFile(join(testHome, 'ustc-guard/live2d-cache/live2dcubismcore.min.js'), core);
  verifyLive2d = true;
} catch {}
const hostCtx = new cordis.Context();
hostCtx.provide('llm', { adapters: new Map([['ustc', { adapter: { current() { return {
  profiles: new Map([['ustc', { baseURL: 'https://api.llm.ustc.edu.cn/v1', streamIdleTimeoutMs: 300000 }]]),
  models: { getModel() { return { id: 'm', baseUrl: 'https://api.llm.ustc.edu.cn/v1' }; }, getModels() { return [{ id: 'm' }]; } },
}; } } }]]) });
const hostRegistryFiber = hostCtx.plugin(TypertRegistry);
await hostRegistryFiber;
const hostGatewayFiber = hostCtx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 1000, streamInboxBytes: 1000 });
await hostGatewayFiber;
let hostSnapshotFiber = hostCtx.plugin(guardPlugin);
await hostSnapshotFiber;
const request = { provider: 'ustc', model: 'm', messages: [{ role: 'user', content: 'test' }], maxTokens: 1000 };
const downstream = () => (async function* () { yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
const timeoutAdapter = hostCtx.llm.adapters.get('ustc').adapter;
const originalStreamWithSnapshot = function (options, snapshot) {
  assert.equal(snapshot.profiles.get(options.provider).streamIdleTimeoutMs, 600000);
  return downstream();
};
timeoutAdapter.streamWithSnapshot = originalStreamWithSnapshot;
const stream = hostCtx.waterfall('llm/stream', request, () => timeoutAdapter.streamWithSnapshot(request, timeoutAdapter.current()));
assert.equal(typeof stream[Symbol.asyncIterator], 'function');
for await (const chunk of stream) {}
assert.equal(timeoutAdapter.current().profiles.get('ustc').streamIdleTimeoutMs, 300000);
console.log('PASS: real Cordis stream interception applies 600000ms with shared route settings unchanged');
const hostGateway = hostCtx.get('typertGateway');
assert.ok(hostGateway.claimsEndpoint('ustcGuard/snapshot'));
const hostResult = await hostGateway.dispatchRpc('ustcGuard/snapshot', { args: {} }, new AbortController().signal, {});
assert.equal(hostResult.ok, true, JSON.stringify(hostResult));
assert.equal(hostResult.value.rpm.used, 1);
console.log('PASS: real Host Gateway claims and dispatches snapshot');
const ctx = new cordis.Context();
ctx.on('internal/error', error => console.error('CORDIS', error));
ctx.provide('connection', {
  registerGenerationSource() { return () => {}; },
  rpc: { open() {}, call: async (_prefix, endpoint, payload, signal) => hostGateway.dispatchRpc(endpoint, JSON.parse(JSON.stringify(payload)), signal, {}) },
  generation: { getSnapshot() {}, subscribe() { return () => {}; } },
  start() { return { stop() {} }; },
});
ctx.provide('slots', { inject(_, fn) { fn(); }, register() {} });
ctx.provide('sessions', {});
ctx.provide('modelDirectories', {});
const registryFiber = ctx.plugin(TypertRegistry);
await registryFiber;
let gateway;
const env = { crypto: webcrypto, window: { __ModuleLoader__: { load({factory}) { gateway = factory(() => cordis); } } }, AbortController, console, setTimeout, clearTimeout, URL, TextEncoder };
runInNewContext(await readFile(new URL('../runtime/dsh-api-gateway__lib__client.js', base), 'utf8'), env);
const gatewayFiber = ctx.plugin(gateway);
await gatewayFiber;
let plugin;
env.window.__ModuleLoader__.load = ({factory}) => { plugin = factory(() => ({ createElement() {} })); };
env.document = { createElement() { return { setAttribute() {}, remove() {} }; }, head: { appendChild() {} } };
runInNewContext(await readFile(new URL('client.js', guardRoot), 'utf8'), env);
const fiber = ctx.plugin(plugin);
await fiber;
console.log('CLIENT STATE', fiber.state);
assert.equal(fiber.state, 2, 'Client must activate under real Cordis and Gateway');
const result = await ctx.get('remote.ustcGuard').snapshot();
assert.equal(result.ok, true, result.error?.message ?? JSON.stringify(result));
assert.equal(result.value.rpm.used, 1);
console.log('PASS: Client namespace -> Host Gateway -> snapshot');
if (verifyLive2d) {
  const assetResult = await ctx.get('remote.ustcGuard').live2d();
  assert.equal(assetResult.ok, true, JSON.stringify(assetResult.error));
  assert.ok(assetResult.value.includes('const MODEL='));
  assert.ok(assetResult.value.includes('Content-Security-Policy'));
  assert.ok(assetResult.value.length > 1000000);
  console.log('PASS: genuine Live2D assets -> real Host Gateway -> Client namespace (offline Core cache)');
} else console.log('SKIP: Live2D RPC payload; locally acquired Core absent');
let retries = 0;
hostCtx.on('agent/request-error', () => { retries++; return { kind: 'retry' }; });
assert.equal(hostCtx.waterfall('agent/request-error', { provider: 'ustc', failure: { code: 'SERVER' } }, () => {}), undefined);
assert.equal(retries, 0);
hostCtx.waterfall('agent/request-error', { provider: 'other', failure: { code: 'SERVER' } }, () => {});
assert.equal(retries, 1);
console.log('PASS: post-dispatch retry veto and provider isolation');
await hostSnapshotFiber.dispose();
for await (const chunk of hostCtx.waterfall('llm/stream', request, downstream)) {}
assert.deepEqual(hostCtx.waterfall('agent/request-error', { provider: 'ustc', failure: { code: 'SERVER' } }, () => {}), { kind: 'retry' });
assert.equal(retries, 2, 'uninstalled Guard must not veto retries');
for await (const chunk of hostCtx.waterfall('llm/stream', { provider: 'other' }, downstream)) {}
hostSnapshotFiber = hostCtx.plugin(guardPlugin);
await hostSnapshotFiber;
const reloaded = await ctx.get('remote.ustcGuard').snapshot();
assert.equal(reloaded.ok, true, reloaded.error?.message);
assert.equal(reloaded.value.rpm.used, 1);
for await (const chunk of hostCtx.waterfall('llm/stream', request, downstream)) {}
assert.equal(hostCtx.get('ustcGuard') !== undefined, true);
console.log('PASS: uninstall bypasses guard and HMR preserves counters');
await fiber.dispose();
assert.equal(ctx.get('remote.ustcGuard'), undefined, 'Namespace must be withdrawn on disposal');
await gatewayFiber.dispose();
await registryFiber.dispose();
await hostSnapshotFiber.dispose();
assert.equal(hostCtx.get('ustcGuard'), undefined);
await hostGatewayFiber.dispose();
await hostRegistryFiber.dispose();
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
await rm(testHome, { recursive: true, force: true });
console.log('PASS: real Cordis/Gateway activation and disposal');
