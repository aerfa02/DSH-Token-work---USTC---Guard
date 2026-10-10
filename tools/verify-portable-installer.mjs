/** Exercise the actual extracted PowerShell 5.1 distribution entry on isolated profiles. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,symlink,lstat,readlink} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
const payload=resolve(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'guard-portable-'));
const script=join(payload,'plugin/_installer/manage-release.ps1');
let pass=0;
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function ps(args,input){const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass',...args],{encoding:'utf8',windowsHide:true,timeout:45000,input});if(r.error)throw r.error;return r;}
async function fixture(name,kind='DSH'){
 const dir=join(root,name),app=join(dir,"应用 Program's & Files"),profile=join(dir,"用户 配置's & data"),exe=join(app,kind==='DSH'?'DeepSeek Harness.exe':'EduWork-Electron.exe');
 await mkdir(app,{recursive:true});await mkdir(profile,{recursive:true});await writeFile(exe,'fixture; never executed');
 if(kind==='DSH'){await mkdir(join(app,'resources'));await writeFile(join(app,'resources/app.asar'),'fixture runtime');}
 else{await mkdir(join(app,'resources/product/d'),{recursive:true});await writeFile(join(app,'resources/product/d/package.json'),'{}');await writeFile(join(app,'release.json'),'{"distribution":"tokenworks"}');}
 const initial={name:'fixture',dependencies:{keep:'1'},dsh:{profile:{bundles:['other-bundle']}},custom:{keep:true}};
 const file=join(profile,'package.json');await writeFile(file,JSON.stringify(initial));
 const usage=join(profile,'ustc-guard/usage.json');await mkdir(join(profile,'ustc-guard'));await writeFile(usage,'keep usage bytes');
 const other=join(dir,'another-profile');await mkdir(other);await writeFile(join(other,'package.json'),'{"keep":"other profile"}');
 const installed=join(profile,'.plugin-manager/plugins/dsh-ustc-api-guard'),link=join(profile,'node_modules/@local/dsh-ustc-api-guard');
 const run=(mode='Install',entry=script)=>ps(['-File',entry,'-Mode',mode,'-Product',kind,'-ApplicationPath',exe,'-ProfileDirectory',profile]);
 const intact=async()=>{assert.equal(await readFile(usage,'utf8'),'keep usage bytes');assert.equal(await readFile(join(other,'package.json'),'utf8'),'{"keep":"other profile"}');assert.equal(await readFile(exe,'utf8'),'fixture; never executed');};
 return {dir,app,profile,exe,kind,file,initial,installed,link,usage,run,intact};
}
function ok(r){assert.equal(r.status,0,r.stdout+'\n'+r.stderr);}
function bad(r){assert.notEqual(r.status,0,'Unexpected success: '+r.stdout);}
async function check(name,fn){await fn();pass++;console.log('PASS:',name);}
async function setReadonly(path,value){ok(ps(['-Command',`[IO.File]::SetAttributes(${quote(path)},[IO.FileAttributes]::${value?'ReadOnly':'Normal'})`]));}
try{
 for(const kind of ['DSH','TokenWorks'])await check(kind+' fresh install, upgrade, uninstall, reinstall; preserve other profiles and usage',async()=>{
  const f=await fixture(kind,kind);ok(f.run());
  let p=JSON.parse(await readFile(f.file,'utf8'));assert.equal(p.dependencies.keep,'1');assert(p.dsh.profile.bundles.includes('other-bundle'));assert(p.dsh.profile.bundles.includes('@local/dsh-ustc-api-guard'));
  assert.equal(await readFile(join(f.installed,'index.js'),'utf8'),await readFile(join(payload,'plugin/index.js'),'utf8'));assert(!(await readdir(f.installed)).includes('_installer'));
  ok(f.run());assert.equal(JSON.parse(await readFile(f.file,'utf8')).dsh.profile.bundles.filter(x=>x==='@local/dsh-ustc-api-guard').length,1);
  ok(f.run('Uninstall'));p=JSON.parse(await readFile(f.file,'utf8'));assert.equal(p.dependencies['@local/dsh-ustc-api-guard'],undefined);assert.deepEqual(p.dsh.profile.bundles,['other-bundle']);assert.equal(await lstat(f.installed).catch(()=>null),null);assert.equal(await lstat(f.link).catch(()=>null),null);await f.intact();
  ok(f.run('Uninstall'));ok(f.run());await f.intact();
 });
 await check('damaged payload rejected before any profile changes',async()=>{
  const f=await fixture('damaged'),broken=join(root,'damaged payload');await cp(payload,broken,{recursive:true});await writeFile(join(broken,'plugin/index.js'),'corrupted');bad(f.run('Install',join(broken,'plugin/_installer/manage-release.ps1')));assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),f.initial);assert.equal(await lstat(f.installed).catch(()=>null),null);await f.intact();
 });
 await check('unmanaged node_modules directory is preserved',async()=>{
  const f=await fixture('unmanaged');await mkdir(f.link,{recursive:true});await writeFile(join(f.link,'keep'),'keep');bad(f.run());bad(f.run('Uninstall'));assert.equal(await readFile(join(f.link,'keep'),'utf8'),'keep');assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),f.initial);
 });
 await check('read-only profile install and uninstall failure preserve runtime and junction',async()=>{
  const f=await fixture('readonly');ok(f.run());const before=await readFile(f.file,'utf8'),target=await readlink(f.link);await setReadonly(f.file,true);
  try{bad(f.run());bad(f.run('Uninstall'));assert.equal(await readFile(f.file,'utf8'),before);assert.equal(await readlink(f.link),target);assert.equal(await readFile(join(f.link,'index.js'),'utf8'),await readFile(join(payload,'plugin/index.js'),'utf8'));await f.intact();}finally{await setReadonly(f.file,false);}
 });
 await check('linked profile parent is rejected before write',async()=>{
  const f=await fixture('parent-link'),outside=join(root,'linked outside');await mkdir(outside);await symlink(outside,join(f.profile,'.plugin-manager'),'junction');bad(f.run());assert.deepEqual(await readdir(outside),[]);assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),f.initial);
 });
 await check('concurrent install/uninstall lock is honored',async()=>{
  const f=await fixture('locked');ok(f.run());const before=await readFile(f.file,'utf8');await writeFile(join(f.profile,'.plugin-manager/plugins/.ustc-guard-install.lock'),'another transaction');bad(f.run());bad(f.run('Uninstall'));assert.equal(await readFile(f.file,'utf8'),before);await f.intact();
 });
 await check('missing host runtime and mismatched application rejected',async()=>{
  const f=await fixture('invalid');await rm(join(f.app,'resources/app.asar'));bad(f.run());assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),f.initial);
  const r=ps(['-File',script,'-Mode','Install','-Product','TokenWorks','-ApplicationPath',f.exe,'-ProfileDirectory',f.profile]);bad(r);
 });
 await check('legacy junction migrates, with original runtime retained',async()=>{
  const f=await fixture('legacy'),legacy=join(f.app,'plugins/dsh-ustc-api-guard');await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'keep'),'legacy');await mkdir(join(f.profile,'node_modules/@local'),{recursive:true});await symlink(legacy,f.link,'junction');const old={...f.initial,dependencies:{keep:'1','@local/dsh-ustc-api-guard':'link:'+legacy.replaceAll('\\','/')}};await writeFile(f.file,JSON.stringify(old));ok(f.run());assert.equal(await readFile(join(legacy,'keep'),'utf8'),'legacy');assert.equal(resolve(await readlink(f.link)).toLowerCase(),resolve(f.installed).toLowerCase());
 });
 await check('running application is rejected before installation or uninstall',async()=>{
  const f=await fixture('running');
  const cs=join(f.dir,'Wait.cs');await writeFile(cs,'class Wait { static void Main(){System.Threading.Thread.Sleep(30000);} }');
  const compiler=join(process.env.WINDIR,'Microsoft.NET/Framework/v4.0.30319/csc.exe');
  const build=spawnSync(compiler,['/nologo','/target:winexe','/out:'+f.exe,cs],{encoding:'utf8',windowsHide:true});ok(build);
  const child=spawn(f.exe,[],{windowsHide:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',reject);setTimeout(resolve,500)});
  try{bad(f.run());bad(f.run('Uninstall'));assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),f.initial);}
  finally{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve)});}
 });
 await check('BAT entry works without Node on PATH and with non-ASCII argument paths',async()=>{
  const f=await fixture('batch');
  const batchPayload=join(root,'解压 & folder!');await cp(payload,batchPayload,{recursive:true});
  for(const mode of ['Install','Uninstall']){
   // Batch path is a controlled test path; user-supplied paths are stdin data, never shell code.
   const bat=join(batchPayload,mode.toLowerCase()+'.bat');
   const env={...process.env,PATH:join(process.env.WINDIR,'System32')+';'+join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0')};
   const r=spawnSync('cmd.exe',['/d','/v:on','/s','/c',mode.toLowerCase()+'.bat'],{env,cwd:batchPayload,encoding:'utf8',input:'1\r\n'+f.exe+'\r\n'+f.profile+'\r\n\r\n',windowsHide:true,windowsVerbatimArguments:true,timeout:45000});ok(r);
  }
  await f.intact();
 });
 console.log('PASS: '+pass+' portable distribution scenarios (PowerShell 5.1, isolated host/profile fixtures)');
}finally{
 // Remove junctions themselves before recursively deleting this test-owned tree.
 async function unlinkJunctions(dir){for(const name of await readdir(dir)){const file=join(dir,name),info=await lstat(file);if(info.isSymbolicLink())await rm(file,{force:true});else if(info.isDirectory())await unlinkJunctions(file);}}
 assert(resolve(root).startsWith(resolve(tmpdir())+sep));await unlinkJunctions(root);await rm(root,{recursive:true,force:true});
}
