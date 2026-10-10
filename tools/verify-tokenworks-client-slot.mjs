import { homedir } from 'node:os'; import { join } from 'node:path';
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {runInNewContext} from 'node:vm';import assert from 'node:assert/strict';
// Native slot integration and initial React render; RPC answers are isolated doubles.
const product=process.env.DSH_RUNTIME_DIRECTORY ?? 'E:/TokenWorks/resources/product/d';const require=createRequire(product+'/package.json');const {Context}=require('@deepseek-ai/cordis');const React=require('react');
function bundle(file){let plugin;runInNewContext(readFileSync(file,'utf8'),{window:{__ModuleLoader__:{load(row){plugin=row.factory(require);}},innerWidth:1000,innerHeight:800,addEventListener(){},removeEventListener(){}},document:{createElement(){return{setAttribute(){},remove(){}}},head:{appendChild(){}}},localStorage:{getItem(){return null}},setInterval,clearInterval,console});return plugin;}
const renderer=bundle(product+'/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js');
const root=new Context();const slots=new renderer.SlotRegistry(root);
root.provide('remote',{async $mount(){}});root.provide('remote.ustcGuard',{async snapshot(){return{ok:true,value:{routes:[]}}}});
root.provide('sessions',{list:{getSnapshot(){return{byId:{}}},subscribe(){return()=>{}}}});root.provide('modelDirectories',{});
root.slots.register({name:'root',children:{'shell.overlay':{kind:'list',scope:'root'}}},()=>null);
const guardPackage=process.env.GUARD_PACKAGE ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'tokenworks-electron', 'dsh', 'plugins', 'dsh-ustc-api-guard');
const plugin=bundle(guardPackage+'/client.js');const fiber=root.plugin(plugin);await fiber;
console.log('FIBER',fiber.state,'OVERLAYS',root.slots.entries('shell.overlay').length);
const entry=root.slots.entries('shell.overlay')[0];assert.ok(entry,'Guard must actually register into the production slot service');
const element=entry.component({});const html=require('react-dom/server').renderToString(element);assert.match(html,/正在连接 USTC 用量监控/);console.log('PASS: actual SlotRegistry and React render Guard loading window');
await fiber.dispose();assert.equal(root.slots.entries('shell.overlay').length,0);console.log('PASS: actual native plugin disposal removes the window');
await root.fiber.dispose();
