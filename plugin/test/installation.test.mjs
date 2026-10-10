import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkInstallation } from '../../tools/check-installation.mjs';

async function fixture(run, linkToSource = false) {
  const root = await mkdtemp(join(tmpdir(), 'guard-install-check-'));
  const source = join(root, 'source'), installed = join(root, 'installed'), profileDirectory = join(root, 'profile');
  await mkdir(source); await mkdir(join(profileDirectory, 'node_modules/@local'), { recursive: true });
  const manifest = { name: '@local/dsh-ustc-api-guard', version: 'test', files: ['index.js'] };
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'index.js'), 'export const name = "test";');
  await cp(source, installed, { recursive: true });
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({ dependencies: { [manifest.name]: 'link:' + installed }, dsh: { profile: { bundles: [manifest.name] } } }));
  const link = join(profileDirectory, 'node_modules/@local/dsh-ustc-api-guard');
  await symlink(linkToSource ? source : installed, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await run({ source, installed, profileDirectory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('independent installation with matching runtime passes read-only verification', () => fixture(async paths => {
  const result = await checkInstallation(paths);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.checks.length, 6);
}));
test('stale link to workspace is detected', () => fixture(async paths => {
  const result = await checkInstallation(paths);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(item => item.name.startsWith('node_modules')).ok, false);
}, true));
test('missing runtime and mismatched runtime are detected', () => fixture(async paths => {
  await writeFile(join(paths.installed, 'index.js'), 'wrong version');
  assert.equal((await checkInstallation(paths)).ok, false);
  await rm(join(paths.installed, 'index.js'));
  assert.equal((await checkInstallation(paths)).ok, false);
}));
test('unsafe manifest paths are rejected without reading outside package', () => fixture(async paths => {
  const unsafe = { name: '@local/dsh-ustc-api-guard', version: 'test', files: ['../secret'] };
  await writeFile(join(paths.source, 'package.json'), JSON.stringify(unsafe));
  await writeFile(join(paths.installed, 'package.json'), JSON.stringify(unsafe));
  assert.equal((await checkInstallation(paths)).ok, false);
}));
