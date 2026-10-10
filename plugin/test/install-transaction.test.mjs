import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, cp, unlink, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const installShell = process.env.GUARD_INSTALL_SHELL ?? 'pwsh.exe';
const script = process.env.GUARD_INSTALL_SCRIPT ?? fileURLToPath(new URL('../../tools/install-local.ps1', import.meta.url));
const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(run, regularLink = false) {
  const root = await mkdtemp(join(tmpdir(), 'guard-install-transaction-'));
  const dsh = join(root, 'dsh'), profile = join(root, 'profile');
  const installed = join(dsh, 'plugins/dsh-ustc-api-guard');
  const link = join(profile, 'node_modules/@local/dsh-ustc-api-guard');
  await mkdir(installed, { recursive: true }); await mkdir(join(profile, 'node_modules/@local'), { recursive: true });
  await writeFile(join(dsh, 'DeepSeek Harness.exe'), 'fixture only, never executable');
  await writeFile(join(installed, 'healthy-old-marker.txt'), 'keep me');
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@local/dsh-ustc-api-guard', version: 'old' }));
  const oldProfile = JSON.stringify({ name: 'fixture', dependencies: { '@local/dsh-ustc-api-guard': 'link:' + installed }, dsh: { profile: { bundles: ['@local/dsh-ustc-api-guard'] } } });
  const profileFile = join(profile, 'package.json');
  await writeFile(profileFile, oldProfile);
  if (regularLink) { await mkdir(link); await writeFile(join(link, 'preserve.txt'), 'unmanaged package'); }
  else await symlink(installed, link, 'junction');
  const attributes = join(root, 'attributes.ps1');
  await writeFile(attributes, 'param([string]$Path,[string]$Attribute)\n[IO.File]::SetAttributes($Path,[Enum]::Parse([IO.FileAttributes],$Attribute))\n');
  const setAttributes = value => {
    const result = spawnSync(installShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', attributes, '-Path', profileFile, '-Attribute', value], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const install = extra => spawnSync(installShell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DshDirectory', dsh, '-ProfileDirectory', profile, ...(extra ?? [])], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  try { await run({ root, dsh, profile, installed, link, oldProfile, profileFile, install, setAttributes }); }
  finally { setAttributes('Normal'); await rm(root, { recursive: true, force: true }); }
}

test('install preflight preserves healthy runtime when package link is unmanaged', { skip: !windows }, () => fixture(async s => {
  const result = s.install();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(s.installed, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(s.profileFile, 'utf8'), s.oldProfile);
  assert.equal(await readFile(join(s.link, 'preserve.txt'), 'utf8'), 'unmanaged package');
}, true));

test('install commit failure restores runtime, profile and junction', { skip: !windows }, () => fixture(async s => {
  s.setAttributes('ReadOnly');
  const result = s.install();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(s.installed, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(s.profileFile, 'utf8'), s.oldProfile);
  assert.equal(await readFile(join(s.link, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
}));

test('healthy staged installation promotes complete runtime and retains backup', { skip: !windows }, () => fixture(async s => {
  const result = s.install();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(s.installed, 'index.js'), 'utf8'), await readFile(join(source, 'index.js'), 'utf8'));
  assert.equal(await readFile(join(s.link, 'client.js'), 'utf8'), await readFile(join(source, 'client.js'), 'utf8'));
  assert.ok((await readdir(join(s.dsh, 'plugins'))).some(name => name.startsWith('dsh-ustc-api-guard-backup-')));
}));

test('installer lock prevents concurrent replacement without touching current files', { skip: !windows }, () => fixture(async s => {
  await writeFile(join(s.dsh, 'plugins/.ustc-guard-install.lock'), 'another run');
  const result = s.install();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(s.installed, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
}));

test('missing source entry is rejected before replacing a healthy installation', { skip: !windows }, () => fixture(async s => {
  const incomplete = join(s.root, 'incomplete-source');
  await cp(source, incomplete, { recursive: true });
  await unlink(join(incomplete, 'client.js'));
  const result = s.install(['-SourceDirectory', incomplete]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(s.installed, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(s.profileFile, 'utf8'), s.oldProfile);
  assert.deepEqual(await readdir(join(s.dsh, 'plugins')), ['dsh-ustc-api-guard']);
}));

test('failed migration restores an original junction pointing to a different directory', { skip: !windows }, () => fixture(async s => {
  const legacy = join(s.root, 'legacy-plugin');
  await mkdir(legacy);
  await writeFile(join(legacy, 'legacy-marker.txt'), 'legacy kept');
  await unlink(s.link);
  await symlink(legacy, s.link, 'junction');
  const originalTarget = await readlink(s.link);
  s.setAttributes('ReadOnly');
  const result = s.install();
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(s.link), originalTarget);
  assert.equal(await readFile(join(s.link, 'legacy-marker.txt'), 'utf8'), 'legacy kept');
  assert.equal(await readFile(join(s.installed, 'healthy-old-marker.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(s.profileFile, 'utf8'), s.oldProfile);
}));
