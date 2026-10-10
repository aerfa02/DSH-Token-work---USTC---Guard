#!/usr/bin/env node
/**
 * asar 导出工具：从 DSH 桌面版的 app.asar 中按路径导出内部文件。
 *
 * 用途
 *   DSH 检出位置的绝大多数 @deepseek-ai/dsh-* 包（含全部 skill / plugin 包）
 *   只存在于 app.asar 打包体内部，磁盘上无法直接读取，shell、node、pnpm、
 *   glob、ripgrep 都打不开。本脚本直接解析 asar 头部 JSON 表，按 offset/size
 *   切片导出，是读取这些官方源码与模板的唯一可行方式。
 *
 * 用法
 *   node tools/asar_extract.js <asar路径> <文件路径1[,文件路径2,...]> <输出目录> [--strip前缀]
 *   node tools/asar_extract.js <asar路径> --list <关键字>
 *   node tools/asar_extract.js <asar路径> --all <路径片段> <输出目录> [--strip前缀]
 *
 *   文件路径须为 asar 内路径，以 / 开头，例如：
 *     /dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js
 *
 * 模式
 *   （默认）  精确导出逗号分隔的若干个文件
 *   --list    只列出匹配关键字的路径，不写文件
 *   --all     递归导出所有路径中包含该片段的文件
 *
 * 选项
 *   --strip <前缀>  输出目录内去掉该前缀再展开，默认 /dsh/node_modules/@deepseek-ai/
 *
 * 输出
 *   导出到 <输出目录>，文件名由 asar 内路径把 / 换成 __ 得到，便于回溯来源。
 *   stdout 打印每个文件的导出结果或匹配清单；文件不存在时打印 NOTFOUND。
 *
 * 依赖
 *   仅需 Node.js 内置模块。Windows 下建议用随包 Node：
 *   E:/dsh/resources/runtime/primary-runtime/dependencies/node/bin/node.exe
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STRIP = '/dsh/node_modules/@deepseek-ai/';

/** 打印用法并退出。 */
function usage(message) {
  if (message !== undefined) console.error('错误：' + message);
  console.error('用法：');
  console.error('  node asar_extract.js <asar路径> <asm内路径1[,路径2...]> <输出目录> [--strip 前缀]');
  console.error('  node asar_extract.js <asar路径> --list <关键字>');
  console.error('  node asar_extract.js <asar路径> --all <路径片段> <输出目录> [--strip 前缀]');
  process.exit(2);
}

/**
 * 解析 asar 归档，返回头部文件表与数据区起始偏移。
 * asar 格式：8 字节 pickle 头 + 4 字节头部长度 + 头部 JSON + 数据区。
 * @param {string} asarPath - app.asar 的路径。
 * @returns {{table: object, dataStart: number, buffer: Buffer}}
 */
function readAsar(asarPath) {
  const buffer = fs.readFileSync(asarPath);
  if (buffer.length < 16) throw new Error('不是有效的 asar 文件（长度不足）：' + asarPath);
  const headerSize = buffer.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerSize;
  if (headerEnd > buffer.length) throw new Error('asar 头部长度越界，文件可能损坏：' + asarPath);
  const headerText = buffer.slice(headerStart, headerEnd).toString('utf8');
  const braceAt = headerText.indexOf('{');
  if (braceAt < 0) throw new Error('asar 头部缺少 JSON 对象：' + asarPath);
  return {
    table: JSON.parse(headerText.slice(braceAt)),
    dataStart: headerEnd,
    buffer,
  };
}

/**
 * 按 asar 内路径在文件表中查找节点。
 * @param {object} table - asar 头部文件表根节点。
 * @param {string} asarPath - 以 / 开头的 asar 内路径。
 * @returns {object|null} 命中的节点，未命中返回 null。
 */
function findNode(table, asarPath) {
  let current = table;
  for (const segment of asarPath.split('/').filter(Boolean)) {
    if (!current.files || !current.files[segment]) return null;
    current = current.files[segment];
  }
  return current;
}

/**
 * 递归收集文件表中的全部文件节点。
 * @param {object} node - 起始节点。
 * @param {string} prefix - 累积的路径前缀。
 * @param {Array<{path: string, node: object}>} out - 收集结果。
 */
function collectFiles(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const full = prefix + '/' + name;
    if (child.files) collectFiles(child, full, out);
    else out.push({ path: full, node: child });
  }
}

/**
 * 把 asar 内路径映射为输出目录下的扁平文件名。
 * @param {string} asarPath - asar 内路径。
 * @param {string} stripPrefix - 需要去掉的前缀。
 * @returns {string} 输出文件名。
 */
function outputName(asarPath, stripPrefix) {
  const trimmed = asarPath.startsWith(stripPrefix) ? asarPath.slice(stripPrefix.length) : asarPath.replace(/^\//, '');
  return trimmed.replace(/\//g, '__');
}

/**
 * 写出一个文件节点到输出目录。
 * @param {object} ctx - readAsar 的返回值。
 * @param {object} node - 文件节点，含 offset 与 size。
 * @param {string} outFile - 输出文件路径。
 */
function writeNode(ctx, node, outFile) {
  const start = ctx.dataStart + Number(node.offset);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, ctx.buffer.slice(start, start + node.size));
}

/**
 * 解析命令行参数：逐项扫描，先摘出模式开关与 --strip，其余为位置参数。
 * 模式开关可出现在任意位置，不依赖其在 argv 中的下标。
 * @param {string[]} argv - 去掉 node 与脚本名后的参数。
 * @returns {{positional: string[], stripPrefix: string, mode: string}}
 */
function parseArgs(argv) {
  const positional = [];
  let stripPrefix = DEFAULT_STRIP;
  let mode = 'exact';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--strip') {
      stripPrefix = argv[i + 1];
      if (stripPrefix === undefined) usage('--strip 需要一个前缀参数');
      i += 1;
    } else if (argv[i] === '--list' || argv[i] === '--all') {
      mode = argv[i].slice(2);
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, stripPrefix, mode };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const { positional, stripPrefix, mode } = parseArgs(argv);
  const [asarPath, selector, outRoot] = positional;
  if (asarPath === undefined || selector === undefined) usage('缺少 asar 路径或选择参数');

  let ctx;
  try {
    ctx = readAsar(asarPath);
  } catch (error) {
    console.error('无法读取 asar：' + error.message);
    process.exit(1);
  }

  if (mode === 'list') {
    const files = [];
    collectFiles(ctx.table, '', files);
    const matched = files.filter((entry) => entry.path.includes(selector));
    console.log('匹配 ' + matched.length + ' 个文件：');
    for (const entry of matched) console.log(entry.path + '  (' + entry.node.size + 'b)');
    return;
  }

  if (mode === 'all') {
    if (outRoot === undefined) usage('--all 需要提供输出目录');
    const files = [];
    collectFiles(ctx.table, '', files);
    const matched = files.filter((entry) => entry.path.includes(selector));
    if (matched.length === 0) {
      console.log('未匹配到任何文件：' + selector);
      return;
    }
    for (const entry of matched) {
      writeNode(ctx, entry.node, path.join(outRoot, outputName(entry.path, stripPrefix)));
    }
    console.log('导出 ' + matched.length + ' 个文件到 ' + outRoot);
    return;
  }

  if (outRoot === undefined) usage('精确导出模式需要提供输出目录');
  let ok = 0;
  let missing = 0;
  for (const target of selector.split(',').map((item) => item.trim()).filter(Boolean)) {
    const node = findNode(ctx.table, target);
    if (node === null || node.files) {
      console.log('NOTFOUND ' + target);
      missing += 1;
      continue;
    }
    const outFile = path.join(outRoot, outputName(target, stripPrefix));
    writeNode(ctx, node, outFile);
    console.log('OK ' + outFile + ' (' + node.size + 'b)');
    ok += 1;
  }
  console.log('完成：成功 ' + ok + ' 个，未找到 ' + missing + ' 个。');
  if (ok === 0) process.exit(1);
}

main();
