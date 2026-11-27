// Read-only storage inventory for the bundled local mesh. Never used for routing.
export const HOST_COLORS={N1:'#388ce8',N2:'#e99b35',N3:'#a37bea'};
const compiled=new WeakMap();
function indexOf(snapshot){
 if(compiled.has(snapshot))return compiled.get(snapshot);
 const collections=new Map(),fresh=()=>({here:0,below:0,children:new Map()});
 snapshot.nodes.forEach((node,i)=>{
  if(!node.available)return;
  for(const [collection,zones] of Object.entries(node.collections)){
   if(!collections.has(collection))collections.set(collection,fresh());
   for(const location of zones){
    let branch=collections.get(collection);branch.below|=1<<i;
    for(const c of location==='@'?'':location){if(!branch.children.has(c))branch.children.set(c,fresh());branch=branch.children.get(c);branch.below|=1<<i;}
    branch.here|=1<<i;
   }
  }
 });compiled.set(snapshot,collections);return collections;
}
export function cellHosts(snapshot,collection,location){
 if(!snapshot||!collection||typeof location!=='string')return [];
 let branch=indexOf(snapshot).get(collection),mask=0;
 if(!branch)return [];
 for(const c of location==='@'?'':location){mask|=branch.here;branch=branch.children.get(c);if(!branch)break;}
 if(branch)mask|=branch.here|branch.below;
 return snapshot.nodes.filter((_,i)=>mask&(1<<i));
}
export function hostedCell(snapshot,collection,cell){
 const hosts=cellHosts(snapshot,collection,cell.location);
 return {...cell,hosts:hosts.map(node=>node.label),color:hosts.length===1?HOST_COLORS[hosts[0].label]:'#93a5b6'};
}
export function createGridHosting(){
 let snapshot=null,pending=null,expires=0,closed=false;
 const abort=new AbortController();
 return {
  snapshot(){
   if(!closed&&Date.now()>expires&&!pending){
    pending=fetch('/api/demo/mesh',{signal:abort.signal}).then(response=>{if(!response.ok)throw Error('Mesh inventory unavailable');return response.json();}).then(value=>{if(!Array.isArray(value.nodes))throw Error('Invalid mesh inventory');snapshot=value;}).catch(()=>{snapshot=null;}).finally(()=>{expires=Date.now()+(snapshot?.nodes.length&&snapshot.nodes.every(node=>node.available)?60000:5000);pending=null;});
   }
   return snapshot;
  },
  destroy(){closed=true;abort.abort();},
 };
}
