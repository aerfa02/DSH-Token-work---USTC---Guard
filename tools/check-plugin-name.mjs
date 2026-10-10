import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { archiveOf } from './asar-read.mjs';

const root = resolve(process.env.GUARD_PACKAGE ?? 'plugin');
const archive = archiveOf(readFileSync(process.env.DSH_ASAR ?? 'E:/dsh/resources/app.asar'));
const boot = archive.read('dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').toString();
const start = boot.indexOf('function dictionariesOf(');
const end = boot.indexOf('//#endregion', start);
assert.ok(start >= 0 && end > start);
const resources = specifier => join(root, specifier.replace('@local/dsh-ustc-api-guard/', ''));
const sandbox = {
  readdirSync, dirname, LANGUAGE_ID: /^[a-z]+(?:-[a-z0-9]+)*$/i,
  resolvePluginResource: resources, optionalResourcePath(specifier) { const path = resources(specifier); return existsSync(path) ? path : undefined; },
  readObject(path) { return JSON.parse(readFileSync(path, 'utf8')); },
  objectOf(value) { return value; },textOf(value) { return value; },fallbackText(value) { return value; },
  barePackageName() { return '@local/dsh-ustc-api-guard'; },iconOf(){return undefined;},
};
const meta = runInNewContext(boot.slice(start, end) + '\nreadPluginMeta("@local/dsh-ustc-api-guard", "file:///profile/")', sandbox);
assert.equal(meta.title.zh, 'USTC API Guard', JSON.stringify(meta));
assert.equal(meta.title.en, 'USTC API Guard');
console.log('PASS: actual DSH inventory metadata reader resolves zh/en title as USTC API Guard');
