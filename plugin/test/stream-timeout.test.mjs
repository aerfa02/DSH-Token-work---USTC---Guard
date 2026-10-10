import test from 'node:test';import assert from 'node:assert/strict';
import {attachUstcTimeout} from '../lib/stream-timeout.js';
const snapshot={profiles:new Map([['alias',Object.freeze({baseURL:'https://api.llm.ustc.edu.cn/v1',streamIdleTimeoutMs:300000})],['other',{baseURL:'https://example.com',streamIdleTimeoutMs:123456}]]),models:{getModel(_,model){return model==='override'?{baseUrl:'https://example.com'}:model==='fish'?{baseUrl:'https://api.llm.ustc.edu.cn/v1'}:{};}}};
test('per-call timeout overrides exact USTC endpoints without mutating shared snapshots',()=>{
 const adapter={streamWithSnapshot(options,snap){return {options,snap,self:this};}};const original=adapter.streamWithSnapshot;const detach=attachUstcTimeout(adapter);
 const options={provider:'alias',model:'m'};const r=adapter.streamWithSnapshot(options,snapshot);
 assert.equal(r.snap.profiles.get('alias').streamIdleTimeoutMs,600000);assert.equal(r.options,options);assert.equal(r.self,adapter);assert.notEqual(r.snap,snapshot);assert.equal(snapshot.profiles.get('alias').streamIdleTimeoutMs,300000);
 assert.equal(adapter.streamWithSnapshot({provider:'alias',model:'override'},snapshot).snap,snapshot);
 assert.equal(adapter.streamWithSnapshot({provider:'other',model:'m'},snapshot).snap,snapshot);
 assert.equal(adapter.streamWithSnapshot({provider:'other',model:'fish'},snapshot).snap.profiles.get('other').streamIdleTimeoutMs,600000);
 detach();assert.equal(adapter.streamWithSnapshot,original);
});
test('HMR leases, disable, unload and third-party replacement remain isolated',()=>{
 let enabled=true;const adapter={streamWithSnapshot(_,s){return s;}};const original=adapter.streamWithSnapshot;
 const one=attachUstcTimeout(adapter,()=>enabled),two=attachUstcTimeout(adapter,()=>enabled);one();
 assert.equal(adapter.streamWithSnapshot({provider:'alias'},snapshot).profiles.get('alias').streamIdleTimeoutMs,600000);
 enabled=false;assert.equal(adapter.streamWithSnapshot({provider:'alias'},snapshot),snapshot);two();assert.equal(adapter.streamWithSnapshot,original);
 const detach=attachUstcTimeout(adapter);const replacement=()=>{};adapter.streamWithSnapshot=replacement;detach();assert.equal(adapter.streamWithSnapshot,replacement);
 assert.equal(attachUstcTimeout({}),null);
});

test('USTC timeout remains active when model discovery throws, and other endpoints stay unchanged', () => {
  const adapter = { streamWithSnapshot(_, s) { return s; } };
  const detach = attachUstcTimeout(adapter);
  const pending = { ...snapshot, models: { getModel() { throw new Error('catalog pending'); } } };
  assert.equal(adapter.streamWithSnapshot({ provider: 'alias', model: 'm' }, pending).profiles.get('alias').streamIdleTimeoutMs, 600000);
  assert.equal(adapter.streamWithSnapshot({ provider: 'other', model: 'm' }, pending), pending);
  assert.equal(pending.profiles.get('alias').streamIdleTimeoutMs, 300000);
  detach();
});
