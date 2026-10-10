/** Check exact release inventory, ZIP checksums and equality to current sources. */
import { readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'plugin/package.json'), 'utf8'));
const release = resolve(process.argv[2] ?? join(root, 'output', `USTC-Guard-${manifest.version}`));
const extracted = await mkdtemp(join(tmpdir(), 'ustc-release-check-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function checkHashes(dir) {
  const listed = new Set();
  for (const line of (await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line); assert.ok(match);
    const file = resolve(dir, match[2]), rel = relative(dir, file);
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel)); assert.ok(!listed.has(match[2]));
    assert.equal(digest(await readFile(file)), match[1], match[2]); listed.add(match[2]);
  }
  const files = [];
  async function visit(folder) { for (const name of await readdir(folder)) { const file = join(folder, name), info = await lstat(file); assert.ok(!info.isSymbolicLink()); if (info.isDirectory()) await visit(file); else if (name !== 'SHA256SUMS.txt') files.push(relative(dir, file).replaceAll('\\', '/')); } }
  await visit(dir); assert.deepEqual(files.sort(), [...listed].sort()); return files.length;
}
async function compare(left, right) {
  const info = await lstat(left); assert.ok(!info.isSymbolicLink());
  if (info.isDirectory()) { assert.deepEqual((await readdir(left)).sort(), (await readdir(right)).sort()); for (const name of await readdir(left)) await compare(join(left, name), join(right, name)); }
  else assert.equal(digest(await readFile(left)), digest(await readFile(right)), right);
}
try {
  assert.deepEqual((await readdir(release)).sort(), ['SHA256SUMS.txt', 'USTC一键安装包.zip', '使用说明.html'].sort());
  await checkHashes(release);
  execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(' + quote(join(release, 'USTC一键安装包.zip')) + ',' + quote(extracted) + ')'], { windowsHide: true });
  console.log('PASS: ZIP checksums:', await checkHashes(extracted));
  assert.deepEqual((await readdir(extracted)).sort(), ['plugin', 'tools', 'install.cmd', '使用说明.html', 'SHA256SUMS.txt'].sort());
  for (const name of ['package.json', ...manifest.files]) await compare(join(root, 'plugin', name), join(extracted, 'plugin', name));
  const client = await readFile(join(extracted, 'plugin/client.js'), 'utf8');
  const mascot = JSON.parse(client.match(/const MASCOT = (\{[^\n]+\});/)?.[1] ?? 'null');
  assert.ok(mascot);
  for (const [pose, extension] of [['front', 'png'], ['idle', 'gif'], ['hover', 'gif']]) assert.equal(mascot[pose], 'data:image/' + extension + ';base64,' + (await readFile(join(extracted, 'plugin/assets', pose + '.' + extension))).toString('base64'));
  assert.deepEqual(Object.keys(mascot).sort(), ['front', 'hover', 'idle']);
  assert.ok(!(await readdir(join(extracted, 'plugin/assets'))).includes('back.png'));
  assert.ok((await readFile(join(extracted, 'plugin/assets/GIF-SOURCE-NOTICE.md'), 'utf8')).includes('gmskywalker'));
  for (const name of ['install-local.ps1', 'share-launcher.ps1', 'check-installation.mjs']) assert.equal((await readFile(join(extracted, 'tools', name), 'utf8')).replace(/^\ufeff/, ''), (await readFile(join(root, 'tools', name), 'utf8')).replace(/^\ufeff/, ''));
  await compare(join(root, 'docs/使用说明.html'), join(extracted, '使用说明.html')); await compare(join(root, 'docs/使用说明.html'), join(release, '使用说明.html'));
  assert.ok((await readFile(join(extracted, 'install.cmd'), 'utf8')).includes('-Mode Install'));
  for (const name of ['install-local.ps1', 'share-launcher.ps1']) assert.deepEqual([...(await readFile(join(extracted, 'tools', name))).subarray(0, 3)], [239, 187, 191]);
  execFileSync(process.execPath, ['--test', '--test-reporter=dot', join(root, 'plugin/test/install-transaction.test.mjs')], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, GUARD_INSTALL_SHELL: 'powershell.exe', GUARD_INSTALL_SCRIPT: join(extracted, 'tools/install-local.ps1') },
  });
  console.log('PASS: plugin source, local assets/licenses, portable entries and Windows PowerShell 5.1 install/rollback');
} finally {
  async function inspect(path) { const info = await lstat(path); assert.ok(!info.isSymbolicLink()); if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name)); }
  assert.ok(resolve(extracted).startsWith(resolve(tmpdir()) + sep)); await inspect(extracted); await rm(extracted, { recursive: true });
}
