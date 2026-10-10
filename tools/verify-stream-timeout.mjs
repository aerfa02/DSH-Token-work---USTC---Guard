/** Installed native adapter + native watchdog, virtual clock, no model/network traffic. */
import {readFile} from 'node:fs/promises';import {runInNewContext} from 'node:vm';import assert from 'node:assert/strict';import {archiveOf} from './asar-read.mjs';
const root=process.env.GUARD_PACKAGE?new URL('file:///'+process.env.GUARD_PACKAGE.replaceAll('\\','/')+'/'):new URL('../plugin/',import.meta.url);
const {attachUstcTimeout}=await import(new URL('lib/stream-timeout.js',root));
const archive=process.env.DSH_RUNTIME_DIRECTORY ? {read: path => readFile(process.env.DSH_RUNTIME_DIRECTORY + '/node_modules/' + path.replace('/dsh/node_modules/',''))} : archiveOf(await readFile('E:/dsh/resources/app.asar'));
const source=(await archive.read('/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')).toString();
const timerSource=(await archive.read('/dsh/node_modules/@deepseek-ai/dsh-timeout/lib/index.js')).toString().replace(/export \{[^}]+\};/,'');
const method=source.slice(source.indexOf('\tasync *streamWithSnapshot(options, snapshot) {'),source.indexOf('\n};',source.indexOf('\tasync *streamWithSnapshot(options, snapshot) {')));
assert.ok(method.includes('idleWatchdog(upstream, streamIdleTimeoutMs'));
const dispose=source.slice(source.indexOf('var __addDisposableResource ='),source.indexOf('function describableReasoningLevel',source.indexOf('var __addDisposableResource =')));
let clock=0,serial=0,timers=new Map(),mode='idle',delay=400000,pulses=[];
const schedule=(fn,ms)=>{const id=++serial;timers.set(id,{at:clock+ms,fn});return id;};
const scope={AbortController,AbortSignal,Symbol,Error,Promise,Map,Number,Math,setTimeout:schedule,clearTimeout:id=>timers.delete(id),
 LlmError:class extends Error{constructor(message,code){super(message);this.code=code;}},resolveReasoningLevel:()=>undefined,contentHasImage:()=>false,toPiContext:()=>({}),profileOptions:()=>({}),requestHeaders:()=>({}),toStreamChunks:x=>x,repairUstcStream:x=>x,trackUstcActivity:x=>x};
const Native=runInNewContext(timerSource+'\n'+dispose+'\n(class { '+method+' })',scope);
Native.prototype.profileOf=(s,p)=>s.profiles.get(p);Native.prototype.modelOf=(s,p,m)=>s.models.getModel(p,m);
const adapter=new Native();adapter.config={resolveApiKey:async()=>undefined};
const profiles=new Map([['alias',{baseURL:'https://api.llm.ustc.edu.cn/v1',streamIdleTimeoutMs:300000}],['other',{baseURL:'https://example.com',streamIdleTimeoutMs:300000}]]);
const snapshot={profiles,models:{getModel:p=>({id:'test',baseUrl:profiles.get(p).baseURL,input:['text'],contextWindow:1000}),streamSimple(_m,_c,{signal}){let sent=false;return {[Symbol.asyncIterator](){return this;},next(){if(sent)return Promise.resolve({done:true});sent=true;return new Promise((resolve,reject)=>{const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(mode==='data')schedule(()=>{signal.removeEventListener('abort',aborted);resolve({done:false,value:{type:'text',text:'ok'}});},delay);});},return(){return Promise.resolve({done:true});}};}}};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const tick=async ms=>{const until=clock+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>until)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}clock=until;await flush();};
function start(provider,signal){const stream=adapter.streamWithSnapshot({provider,model:'test',messages:[],signal},snapshot);return {stream,result:stream.next().then(value=>({value}),error=>({error}))};}
const detach=attachUstcTimeout(adapter);
let r=start('alias');await flush();assert.equal([...timers.values()][0].at-clock,600000);await tick(300001);assert.equal(timers.size,1);await tick(299999);assert.equal((await r.result).error.code,'TIMEOUT');assert.match((await r.result).error.message,/600000ms/);console.log('PASS: actual adapter/watchdog waits beyond 300000 and times out at 600000ms');
r=start('other');await flush();await tick(300000);assert.match((await r.result).error.message,/300000ms/);console.log('PASS: non-USTC keeps 300000ms');
mode='data';r=start('alias');await flush();await tick(400000);assert.equal((await r.result).value.value.text,'ok');assert.equal((await r.stream.next()).done,true);console.log('PASS: first data after five minutes completes normally');
mode='idle';const cancel=new AbortController();r=start('alias',cancel.signal);await flush();cancel.abort('user cancel');await flush();assert.equal((await r.result).error.code,'ABORTED');assert.equal(timers.size,0);console.log('PASS: caller cancellation stays ABORTED and releases timers');
detach();r=start('alias');await flush();await tick(300000);assert.match((await r.result).error.message,/300000ms/);assert.equal(profiles.get('alias').streamIdleTimeoutMs,300000);console.log('PASS: unload restores native behavior, shared settings unchanged');
