import test from 'node:test';
import assert from 'node:assert/strict';
import { createGridHosting } from '../../src/experiences/explore/gridHosting.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,read){
 const fetch=globalThis.fetch,now=Date.now;let clock=1000,calls=0,lastSignal;
 Date.now=()=>clock;globalThis.fetch=async(_url,{signal})=>{calls++;lastSignal=signal;return read(calls);};
 const client=createGridHosting();
 t.after(()=>{client.destroy();globalThis.fetch=fetch;Date.now=now;});
 return {client,calls:()=>calls,advance:ms=>{clock+=ms;},signal:()=>lastSignal};
}
const complete={nodes:[{available:true},{available:true},{available:true}]};
const response=value=>({ok:true,json:async()=>value});
for(const [name,initial] of [['all unavailable',{nodes:[{available:false}]}],['partial',{nodes:[{available:true},{available:false}]}],['empty',{nodes:[]}]]){
 test(`${name} inventory retries after five seconds`,async t=>{
  const f=fixture(t,n=>response(n===1?initial:complete));
  f.client.snapshot();await settle();assert.deepEqual(f.client.snapshot(),initial);
  f.advance(4999);f.client.snapshot();assert.equal(f.calls(),1);
  f.advance(2);f.client.snapshot();await settle();assert.equal(f.calls(),2);assert.deepEqual(f.client.snapshot(),complete);
 });
}
test('a failed request retries without waiting one minute',async t=>{
 const f=fixture(t,n=>n===1?Promise.reject(Error('network unavailable')):response(complete));
 f.client.snapshot();await settle();assert.equal(f.client.snapshot(),null);
 f.advance(5001);f.client.snapshot();await settle();assert.deepEqual(f.client.snapshot(),complete);
});
test('complete inventory retains its minute cache',async t=>{
 const f=fixture(t,()=>response(complete));f.client.snapshot();await settle();
 f.advance(59999);f.client.snapshot();assert.equal(f.calls(),1);
 f.advance(2);f.client.snapshot();await settle();assert.equal(f.calls(),2);
});
test('pending calls coalesce and destroying aborts further refresh',async t=>{
 let resolve;const f=fixture(t,()=>new Promise(done=>{resolve=done;}));
 for(let i=0;i<8;i++)f.client.snapshot();assert.equal(f.calls(),1);
 f.client.destroy();assert.equal(f.signal().aborted,true);
 resolve(response(complete));await settle();f.advance(120000);f.client.snapshot();assert.equal(f.calls(),1);
});
