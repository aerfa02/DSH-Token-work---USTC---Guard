import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, htmlOf, exampleSnapshot } from '../../tools/ui-harness.mjs';
function nodes(h, n=h.render()) {
 if (!n || typeof n!=='object') return [];
 if(Array.isArray(n))return n.flatMap(x=>nodes(h,x));
 if(typeof n.type==='function')return nodes(h,h.resolve(n));
 return [n,...n.children.flatMap(x=>nodes(h,x))];
}
const now=Date.parse('2026-10-05T09:00:00+08:00');
const snap={...exampleSnapshot,lastSync:now,history:{timezone:'Asia/Shanghai',startedAt:now-86400000,daily:[{date:'2026-10-04',inputTokens:100,totalTokens:100},{date:'2026-10-05',cacheReadTokens:100,totalTokens:100}],timeline:[]}};
test('axis toggles both charts and preserves token filters; equal tokens have different classified costs',async()=>{
 const h=await uiHarness({details:true,snap,metric:'cacheReadTokens'});
 const toggle=()=>nodes(h).find(n=>n.props['aria-label']==='纵轴指标');
 toggle().children[1].props.onClick();
 let html=htmlOf(h,h.render());assert.equal(h.state[12],'cost');
 assert.match(html,/时段预计费用统计图/);assert.match(html,/每日 预计费用历史条形图/);assert.doesNotMatch(html,/Token 类型筛选/);
 const history=nodes(h).find(n=>n.props['aria-label']==='每日 预计费用历史条形图');
 const columns=nodes(h,history).filter(n=>n.props.className?.startsWith('ustc-guard__chart-column'));
 const heights=columns.map(n=>parseFloat(nodes(h,n).find(x=>x.props.className==='ustc-guard__chart-stack').props.style.height));
 assert.equal(heights[0]/heights[1],10);assert.ok(heights[0]>90);assert.match(html,/¥0.0002/);
 toggle().children[0].props.onClick();html=htmlOf(h,h.render());assert.match(html,/Token 纵轴刻度/);assert.equal(h.state[9],'cacheReadTokens');
});
test('cost axis keeps all ranges at 24 columns and unknown usage marked pending',async()=>{
 const h=await uiHarness({details:true,snap,axis:'cost'});
 for(const range of ['3h','6h','12h','24h']) {
 h.state[11]=range;const chart=nodes(h).find(n=>n.props['aria-label']==='时段预计费用统计图');
 assert.equal(chart.children.length,24);assert.match(htmlOf(h,h.render()),/未记录/);
 }
 for(const period of ['daily','weekly','monthly']){h.state[7]=period;assert.match(htmlOf(h,h.render()),/预计费用纵轴刻度/);}
});
