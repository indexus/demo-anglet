import { encodeFixed, zoneKeyID } from 'js-indexus-sdk';
import { HOST_COLORS } from './gridHosting.js';
export const MAX_ADDRESS_LABELS=2;
const TITLES={terrain:'Terrain',ortho:'Aerial photo',buildings:'Buildings',vegetation:'Vegetation',weather:'Weather'};
export function cellAddress(collection,location){
 return collection&&typeof location==='string'?encodeFixed(zoneKeyID(collection,location)):null;
}
// Bound the sample once per grid update, rather than scanning every cell per frame.
export function addressSamples(cells,centre,perRole=6){
 const roles=new Map();
 for(const cell of cells){
  if(!cell.collection||typeof cell.location!=='string')continue;
  const b=cell.bounds,dx=(b.west+b.east)/2-centre.lng,dy=(b.south+b.north)/2-centre.lat;
  const list=roles.get(cell.role)??[];list.push({cell,score:dx*dx+dy*dy});roles.set(cell.role,list);
 }
 return [...roles.values()].flatMap(rows=>rows.sort((a,b)=>a.score-b.score).slice(0,perRole).map(row=>row.cell));
}
export function createMapAddresses({map,getSnapshot,projectCube,legendHost}){
 const container=map.getContainer(),nodes=document.createElement('aside'),labels=document.createElement('div');
 nodes.className='scene-map-nodes';nodes.setAttribute('aria-label','Storage nodes and their Base64 addresses');
 labels.className='scene-map-addresses';labels.setAttribute('aria-label','Sample cell addresses');
 nodes.textContent='Loading storage nodes…';nodes.hidden=labels.hidden=true;(legendHost??container).append(nodes);container.append(labels);
 let mesh,samples=[],rendered=[],enabled=false;
 const syncNodes=()=>{
  if(!enabled)return;
  const next=getSnapshot();if(next===mesh)return;mesh=next;nodes.replaceChildren();
  const heading=document.createElement('p');heading.textContent='Grid hosts · Base64';nodes.append(heading);
  if(!mesh){nodes.append(document.createTextNode('Waiting for storage inventory…'));return;}
  for(const node of mesh.nodes){
   const card=document.createElement('div');card.className='scene-map-node';card.style.setProperty('--node-color',HOST_COLORS[node.label]??'#93a5b6');
   const title=document.createElement('strong');title.textContent=node.label+(node.available?'':' · unavailable');
   const address=document.createElement('code');address.textContent=node.name??'Address unavailable';
   card.title='Independent local node · '+Object.keys(node.collections).length+' collections · '+mesh.observedAt;
   card.append(title,address);nodes.append(card);
  }
 };
 function layout(){
  if(!enabled)return;
  const occupied=[],width=container.clientWidth,height=container.clientHeight;let used=0;
  for(const cell of samples){
   const b=cell.bounds;
   const p=cell.volumetric&&cell.volume?projectCube(cell):map.project([(b.west+b.east)/2,(b.south+b.north)/2]);
   if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<90||p.x>width-90||p.y<70||p.y>height-35)continue;
   const box=[p.x-85,p.y-45,p.x+85,p.y];
   if(occupied.some(a=>box[0]<a[2]&&box[2]>a[0]&&box[1]<a[3]&&box[3]>a[1]))continue;
   occupied.push(box);
   let label=rendered[used];
   if(!label){label=document.createElement('div');label.className='scene-cell-address';label.append(document.createElement('span'),document.createElement('code'));labels.append(label);rendered.push(label);}
   label.hidden=false;label.style.transform='translate('+p.x+'px,'+p.y+'px) translate(-50%,-100%)';
   label.style.borderColor=cell.color??'#93a5b6';
   const title=(TITLES[cell.role]??cell.role)+' '+(cell.volume&&cell.volumetric?'cube':'cell')+(cell.hosts?.length?' · '+cell.hosts.join('+'):'');
   const address=cell.address;
   if(label.firstChild.textContent!==title)label.firstChild.textContent=title;
   if(label.lastChild.textContent!==address)label.lastChild.textContent=address;
   label.title=cell.collection+' · zone '+(cell.location||'@')+' · routing address (Base64)';
   if(++used===MAX_ADDRESS_LABELS)break;
  }
  for(let i=used;i<rendered.length;i++)rendered[i].hidden=true;
 }
 const timer=setInterval(syncNodes,1000);syncNodes();map.on('render',layout);
 return {
  setVisible(value){enabled=value;nodes.hidden=labels.hidden=!value;if(value){syncNodes();layout();}},
  setCells(cells){samples=addressSamples(cells,map.getCenter()).map(cell=>({...cell,address:cellAddress(cell.collection,cell.location)}));layout();},
  destroy(){clearInterval(timer);map.off('render',layout);nodes.remove();labels.remove();samples=[];rendered=[];},
 };
}
