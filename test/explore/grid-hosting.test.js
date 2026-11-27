import test from 'node:test';
import assert from 'node:assert/strict';
import {cellHosts,hostedCell} from '../../src/experiences/explore/gridHosting.js';
const snapshot={nodes:[{label:'N1',available:true,collections:{one:['A'],two:['B']}},{label:'N2',available:true,collections:{one:['BA']}},{label:'N3',available:true,collections:{one:['BB'],two:['A']}}]};
const hosts=(c,l)=>cellHosts(snapshot,c,l).map(n=>n.label);
test('stored parents and descendants resolve hosts without geometric guesses',()=>{
 assert.deepEqual(hosts('one','BA000'),['N2']);assert.deepEqual(hosts('one','B'),['N2','N3']);
 assert.deepEqual(hosts('one','@'),['N1','N2','N3']);assert.deepEqual(hosts('one','C'),[]);
 assert.deepEqual(hosts('two','A'),['N3']);assert.deepEqual(cellHosts(null,'one','A'),[]);
});
test('host colours distinguish one stored node from shared parent cells and unknown data',()=>{
 const cell={id:'same geometry',location:'BA0',volume:{min:[0,0,0],max:[1,1,1]}};
 const hosted=hostedCell(snapshot,'one',cell);assert.deepEqual(hosted.hosts,['N2']);assert.equal(hosted.color,'#e99b35');
 assert.equal(hostedCell(snapshot,'one',{...cell,location:'B'}).color,'#93a5b6');
 assert.deepEqual(hostedCell(snapshot,'missing',cell).hosts,[]);
});
