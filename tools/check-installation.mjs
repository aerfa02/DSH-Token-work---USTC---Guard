import { homedir } from 'node:os';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const packageName = '@local/dsh-ustc-api-guard';
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;

/** Read-only checks: never prints profile contents or changes installation. */
export async function checkInstallation({
  source = fileURLToPath(new URL('../plugin/', import.meta.url)),
  installed = process.env.GUARD_PACKAGE ?? 'E:/dsh/plugins/dsh-ustc-api-guard',
  profileDirectory = process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'desktop'),
} = {}) {
  const checks = [];
  async function check(name, fn) {
    try { if (!await fn()) throw new Error('不符合预期'); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, reason: error.code ?? error.message }); }
  }
  let original, runtime, profile;
  await check('源码与安装副本 manifest 合法且版本一致', async () => {
    original = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    runtime = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    return original.name === packageName && runtime.name === packageName && original.version === runtime.version;
  });
  await check('运行副本是独立目录', async () => !((await lstat(installed)).isSymbolicLink())
    && canonical(await realpath(source)) !== canonical(await realpath(installed)));
  await check('profile 启用了正确 bundle', async () => {
    profile = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'));
    return profile.dsh?.profile?.bundles?.includes(packageName);
  });
  await check('profile 依赖指向运行副本', async () => {
    const dependency = profile?.dependencies?.[packageName];
    if (typeof dependency !== 'string' || !dependency.startsWith('link:') || !isAbsolute(dependency.slice(5))) return false;
    return canonical(await realpath(dependency.slice(5))) === canonical(await realpath(installed));
  });
  await check('node_modules 链接指向运行副本', async () => canonical(await realpath(join(profileDirectory, 'node_modules/@local/dsh-ustc-api-guard')))
    === canonical(await realpath(installed)));
  await check('运行文件无链接或路径越界且内容与源码一致', async () => {
    if (!original || !Array.isArray(original.files)) return false;
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    async function compare(name) {
      if (typeof name !== 'string' || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('非法清单路径');
      const left = resolve(source, name), right = resolve(installed, name);
      for (const [root, path] of [[source, left], [installed, right]]) {
        const rel = relative(resolve(root), path);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件越界');
      }
      const a = await lstat(left), b = await lstat(right);
      if (a.isSymbolicLink() || b.isSymbolicLink()) throw new Error('包内存在链接');
      if (a.isDirectory() && b.isDirectory()) {
        const names = (await readdir(left)).sort(), peers = (await readdir(right)).sort();
        if (JSON.stringify(names) !== JSON.stringify(peers)) throw new Error('目录文件不一致');
        for (const item of names) await compare(join(name, item));
      } else if (a.isFile() && b.isFile()) {
        if (hash(await readFile(left)) !== hash(await readFile(right))) throw new Error('运行文件内容不一致');
      } else throw new Error('运行文件类型不一致');
    }
    for (const name of ['package.json', ...original.files.filter(name => name !== 'docs')]) await compare(name);
    return true;
  });
  return { ok: checks.every(item => item.ok), checks };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await checkInstallation();
  for (const item of result.checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}: ${item.name}${item.ok ? '' : ' (' + item.reason + ')'}`);
  process.exitCode = result.ok ? 0 : 1;
}
