/** One portable plugin-only ZIP; no npm, system patches, credentials or state. */
import { mkdir, readFile, writeFile, copyFile, readdir, lstat, rm, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'plugin');
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const release = resolve(process.argv[2] ?? join(root, 'output', `USTC-Guard-${manifest.version}`));
try { await lstat(release); throw new Error('发布目录已存在，拒绝覆盖。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await import('./build-help.mjs');
const stage = await mkdtemp(join(tmpdir(), 'ustc-release-'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function copyTree(from, to) {
  const info = await lstat(from); if (info.isSymbolicLink()) throw new Error('禁止打包链接');
  if (info.isDirectory()) { await mkdir(to, { recursive: true }); for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name)); }
  else if (info.isFile()) { await mkdir(resolve(to, '..'), { recursive: true }); await copyFile(from, to); }
  else throw new Error('非法文件类型');
}
async function checksums(dir, output = join(dir, 'SHA256SUMS.txt')) {
  const lines = [];
  async function visit(folder) { for (const name of (await readdir(folder)).sort()) {
    const file = join(folder, name), info = await lstat(file); if (info.isSymbolicLink()) throw new Error('禁止校验链接');
    if (info.isDirectory()) await visit(file); else if (name !== 'SHA256SUMS.txt') lines.push(digest(await readFile(file)) + '  ' + relative(dir, file).replaceAll('\\', '/'));
  } }
  await visit(dir); await writeFile(output, lines.join('\n') + '\n');
}
try {
  for (const name of ['package.json', ...manifest.files]) {
    if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('清单路径越界');
    await copyTree(join(source, name), join(stage, 'plugin', name));
  }
  for (const name of ['install-local.ps1', 'uninstall-local.ps1', 'manage-release.ps1', 'share-launcher.ps1']) {
    await copyTree(join(root, 'tools', name), join(stage, 'plugin/_installer', name));
    if (name.endsWith('.ps1')) await writeFile(join(stage, 'plugin/_installer', name), '\ufeff' + (await readFile(join(root, 'tools', name), 'utf8')).replace(/^\ufeff/, ''));
  }
  for (const [name,mode] of [['install.bat','Install'],['uninstall.bat','Uninstall']]) {
    await writeFile(join(stage,name), '@echo off\r\nsetlocal DisableDelayedExpansion\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0plugin\\_installer\\share-launcher.ps1" -Mode '+mode+'\r\nset "result=%errorlevel%"\r\necho.\r\npause\r\nexit /b %result%\r\n');
  }
  await copyTree(join(root, 'README.md'), join(stage, 'README.md'));
  await checksums(stage,join(stage,'plugin/_installer/SHA256SUMS.txt')); await mkdir(release, { recursive: true });
  execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -Path ' + quote(join(stage, '*')) + ' -DestinationPath ' + quote(join(release, 'DSH-Token-Guard-v1.0.0.zip')) + ' -CompressionLevel Optimal'], { windowsHide: true, stdio: 'inherit' });
  await copyTree(join(root, 'docs/使用说明.html'), join(release, '使用说明.html')); await copyTree(join(root, 'docs/RELEASE-NOTES.md'), join(release, 'RELEASE-NOTES.md')); await checksums(release);
  console.log('RELEASE:', release);
} finally {
  async function inspect(path) { const info = await lstat(path); if (info.isSymbolicLink()) throw new Error('临时目录出现链接，保留待检查'); if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name)); }
  if (!resolve(stage).startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录越界');
  await inspect(stage); await rm(stage, { recursive: true });
}
