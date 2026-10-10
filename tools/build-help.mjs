/** README is the single customer guide; generate offline HTML and portable plugin README. */
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const markdown=await readFile(join(root,'README.md'),'utf8');
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function inline(text){return escape(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>`<a href="${url}">${label}</a>`);}
const output=[];let list=null,paragraph=[];
function flush(){if(paragraph.length){output.push('<p>'+inline(paragraph.join(' '))+'</p>');paragraph=[];}if(list){output.push(`</${list}>`);list=null;}}
for(const line of markdown.split(/\r?\n/)){
  if(!line.trim()){flush();continue;}
  const heading=/^(#{1,3}) (.+)$/.exec(line);
  if(heading){flush();output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);continue;}
  const image=/^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
  if(image){flush();const path=resolve(root,image[2]);const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel)||!path.endsWith('.png')||(await lstat(path)).isSymbolicLink())throw new Error('Unsafe preview image');const bytes=await readFile(path);output.push(`<figure><img alt="${escape(image[1])}" src="data:image/png;base64,${bytes.toString('base64')}"></figure>`);continue;}
  const item=/^(?:- |\d+\. )(.+)$/.exec(line);
  if(item){const type=line.startsWith('- ')?'ul':'ol';if(list!==type){flush();list=type;output.push(`<${type}>`);}output.push('<li>'+inline(item[1])+'</li>');continue;}
  if(list)flush();paragraph.push(line);
}
flush();
const digest=createHash('sha256').update(markdown).digest('hex');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="guide-sha256" content="${digest}"><title>USTC API Guard · 使用说明</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f7fc;color:#24364e;font:16px/1.8 system-ui,"Microsoft YaHei",sans-serif}main{max-width:860px;margin:32px auto;padding:28px 36px;background:#fff;border:1px solid #dce7f4;border-radius:16px}h1{font-size:30px;line-height:1.4;margin:0 0 16px;color:#225d9e}h2{font-size:23px;margin:30px 0 10px;color:#225d9e}h3{font-size:18px;margin:22px 0 8px}p{margin:10px 0}li{margin:5px 0}ul,ol{padding-left:24px}code{padding:2px 5px;background:#edf3fb;border-radius:4px;font:14px Consolas,monospace;overflow-wrap:anywhere}a{color:#225d9e;overflow-wrap:anywhere}figure{margin:12px 0 24px}img{display:block;max-width:100%;height:auto;border:1px solid #dce7f4;border-radius:10px}@media(max-width:600px){main{margin:12px;padding:20px 18px}h1{font-size:25px}h2{font-size:21px}}@media print{body{background:#fff}main{border:0;margin:0;padding:0}figure{break-inside:avoid}}
</style></head><body><main>${output.join('\n')}</main></body></html>\n`;
await writeFile(join(root,'docs/使用说明.html'),html);
await writeFile(join(root,'plugin/README.md'),markdown.replaceAll('](plugin/',']('));
console.log('HELP: generated from README, embedded four local previews; source '+digest);
