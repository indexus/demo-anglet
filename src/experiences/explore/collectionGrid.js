// Optional map diagnostics: retained loaded cells, never a new network walk.
import { hostedCell } from "./gridHosting.js";
import { Collection, Space } from "js-indexus-sdk";
import { cellBounds, cellOfLocation, tileAnchor, localFrame } from "../point-cloud/geoSpace.js";

export const GRID_COLORS={terrain:"#9c6b37",ortho:"#1687ab",buildings:"#db6b2c",vegetation:"#238858",weather:"#9563ba"};
function* retainedNodes(nodes,descend=()=>true){
  for(const node of nodes??[]){
    if(node.state===-1)continue;
    yield node;
    if(node.children?.length&&descend(node))yield* retainedNodes(node.children,descend);
  }
}
const nodeDepth=(grid,node)=>grid.kind==="gps-tree"?node.depth*3:node.location==="@"?0:node.location.length*2;

const rectangle=({west,south,east,north})=>[[west,south],[east,south],[east,north],[west,north],[west,south]];
const spaces=new Map();
function* gridCells(grid,depth){
  if(!grid)return;
  if(grid.kind==="gps-tiles"){
    for(const {t,row,col} of grid.cells){
      if(depth!==null&&t>depth)continue;
      yield {id:`${t}/${row}/${col}`,...(grid.collection?{location:tileAnchor(t,row,col,grid.collection)}:{}),bounds:cellBounds(row,col,t)};
    }
  }else if(grid.kind==="gps-tree"){
    const seen=new Set();
    for(const node of retainedNodes(grid.roots,node=>depth===null||nodeDepth(grid,node)<depth)){
      if(depth!==null&&nodeDepth(grid,node)>depth)continue;
      const location=node.location.slice(0,node.depth);
      if(seen.has(location))continue;seen.add(location);
      const {row,col,depth:cellDepth}=cellOfLocation(location,grid.collection);
      yield {id:location,location,bounds:cellBounds(row,col,cellDepth*3)};
    }
  }else if(grid.kind==="linear-tree"){
    const {min,side}=grid.space,key=grid.collection+"/"+min.join()+"/"+side;
    let space=spaces.get(key);
    if(!space){const definition=new Collection(grid.collection,["x","y","z"].map((name,i)=>({name,type:"linear",args:[min[i],min[i]+side]})));space=new Space(definition.dimensions(),definition.mask(),definition.offset());spaces.set(key,space);}
    const frame=localFrame(grid.scene),seen=new Set();
    for(const node of retainedNodes(grid.roots,node=>depth===null||nodeDepth(grid,node)<depth)){
      if(depth!==null&&nodeDepth(grid,node)>depth)continue;
      const segments=space.decode(node.location),[x0,x1]=segments[0].value(),[y0,y1]=segments[1].value(),[z0,z1]=segments[2].value(),id=[x0,x1,y0,y1,z0,z1].join();
      if(seen.has(id))continue;seen.add(id);
      const [south,west]=frame.toDegrees(x0,y0),[north,east]=frame.toDegrees(x1,y1);
      yield {id,location:node.location,bounds:{west,south,east,north},volume:{min:[x0,y0,z0],max:[x1,y1,z1]},scene:grid.scene};
    }
  }else if(grid.kind==="gps-zones"){
    const locations=[...grid.locations];
    for(const active of grid.activeLocations){
      const ancestors=locations.filter(location=>location==="@"||active===location||active.startsWith(location))
        .sort((a,b)=>(a==="@"?0:a.length)-(b==="@"?0:b.length));
      const eligible=ancestors.filter(location=>depth===null||(location==="@"?0:location.length*3)<=depth);
      const location=eligible.at(-1)??ancestors[0];
      if(location===undefined)continue;
      const {row,col,depth:cellDepth}=cellOfLocation(location==="@"?"":location,grid.collection);
      yield {id:location,location,bounds:cellBounds(row,col,cellDepth*3)};
    }
  }
}
/** Deepest retained grid level: one step halves each horizontal cell dimension. */
export function gridDepth(grid){
  if(!grid)return 0;
  if(grid.kind==="gps-zones"){let maximum=0;for(const location of grid.activeLocations)maximum=Math.max(maximum,location==="@"?0:location.length*3);return maximum;}
  let deepest=0;
  if(grid.kind==="gps-tiles")for(const cell of grid.cells)deepest=Math.max(deepest,cell.t);
  else for(const node of retainedNodes(grid.roots))deepest=Math.max(deepest,nodeDepth(grid,node));
  return deepest;
}
/** Retained cells up to an absolute depth; keep loaded parents, never synthesize a grid. */
export function* loadedGridCells(grid,depth=null){
  if(depth!==null&&(!Number.isInteger(depth)||depth<0||depth>48))throw new RangeError("Invalid grid depth");
  const seen=new Set();
  for(const cell of gridCells(grid,depth)){
    if(seen.has(cell.id))continue;seen.add(cell.id);yield cell;
  }
}
export function gridFeatures(role,grid,view,depth=null,cells=loadedGridCells(grid,depth)){
  const features=[],seen=new Set();
  for(const {id,bounds:b,volume} of cells){
    if(grid.volumetric&&volume)continue;
    const footprint=[b.west,b.south,b.east,b.north].join();if(seen.has(footprint))continue;seen.add(footprint);
    if(view&&(b.east<view.west||b.west>view.east||b.north<view.south||b.south>view.north))continue;
    features.push({type:"Feature",id:role+"/"+id,properties:{role,color:GRID_COLORS[role]},geometry:{type:"LineString",coordinates:rectangle(b)}});
  }
  return features;
}
// Add real loaded parents first, then nearby descendants, within a draw budget.
export function boundedGridCells(grids,view,maximum,budget){
  const selected=[],seen=new Set(),cx=(view.west+view.east)/2,cy=(view.south+view.north)/2;
  for(let depth=0;depth<=maximum&&selected.length<budget;depth++){
    const next=[];
    for(const [role,grid] of grids)for(const cell of loadedGridCells(grid,depth)){
      const b=cell.bounds,key=role+"/"+cell.id;
      if(seen.has(key)||b.east<view.west||b.west>view.east||b.north<view.south||b.south>view.north)continue;
      seen.add(key);
      next.push({...cell,role,collection:grid?.collection,volumetric:!!grid?.volumetric,score:((b.west+b.east)/2-cx)**2+((b.south+b.north)/2-cy)**2});
    }
    next.sort((a,b)=>a.score-b.score);
    selected.push(...next.slice(0,budget-selected.length));
  }
  return selected;
}
export function createCollectionGrid(map,getGrid,onDepthRange=()=>{},onVolumes=()=>{},getHosting=()=>null,onCells=()=>{}){
  const source="scene-loaded-grids",layer="scene-loaded-grid-lines",active=new Set();
  map.addSource(source,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:layer,type:"line",source,paint:{"line-color":["get","color"],"line-width":1.3,"line-opacity":.8}});
  let signature=null,resolution=null,density=null;
  const update=()=>{
    if(!active.size)return;
    const b=map.getBounds(),view={west:b.getWest(),east:b.getEast(),south:b.getSouth(),north:b.getNorth()};
    const grids=[...active].map(role=>{
      const grid=getGrid(role);
      if(grid?.kind==="gps-tiles")return [role,{...grid,cells:[...grid.cells]}];
      if(grid?.kind==="gps-zones")return [role,{...grid,locations:[...grid.locations],activeLocations:[...grid.activeLocations]}];
      return [role,grid];
    });
    const maxDepth=Math.max(0,...grids.map(([,grid])=>gridDepth(grid)));
    const container=map.getContainer?.(),automatic=Math.max(32,Math.min(96,Math.round((container?.clientWidth??1200)*(container?.clientHeight??800)/80000)*8));
    const budget=density??automatic,depth=resolution===null?maxDepth:Math.min(resolution,maxDepth);
    const hosting=getHosting(),selected=boundedGridCells(grids,view,depth,budget).map(cell=>({...hostedCell(hosting,cell.collection,cell),role:cell.role,collection:cell.collection,volumetric:cell.volumetric}));
    const features=grids.flatMap(([role,grid])=>{
      const cells=selected.filter(cell=>cell.role===role),byId=new Map(cells.map(cell=>[cell.id,cell]));
      return gridFeatures(role,grid,view,depth,cells).map(feature=>{
        const cell=byId.get(feature.id.slice(role.length+1));
        feature.properties.color=hosting?cell.color:GRID_COLORS[role];
        feature.properties.hosts=cell.hosts.join("+");return feature;
      });
    });
    const volumes=selected.filter(cell=>cell.volumetric&&cell.volume);
    onVolumes(volumes);
    onCells(selected);
    onDepthRange({depth,maxDepth,zones:features.length+volumes.length,budget,...(hosting?{hosting}:{})});
    const next=features.map(f=>f.id+"/"+f.properties.hosts).concat(volumes.map(cell=>"3d/"+cell.id+"/"+cell.hosts.join())).sort().join("|");
    if(next===signature)return;signature=next;
    map.moveLayer(layer);map.getSource(source).setData({type:"FeatureCollection",features});
  };
  const timer=setInterval(update,1000);map.on("moveend",update);
  return {
    setDensity(count){if(!Number.isInteger(count)||count<16||count>320)throw new RangeError("Invalid grid density");density=count;signature=null;update();},
    setResolution(level){
      if(!Number.isInteger(level)||level<0||level>48)throw new RangeError("Invalid grid depth");
      resolution=level;signature=null;update();
    },
    toggle(role,show){if(show)active.add(role);else active.delete(role);signature=null;if(active.size)update();else {map.getSource(source).setData({type:"FeatureCollection",features:[]});onVolumes([]);onCells([]);onDepthRange({depth:0,maxDepth:0,zones:0});}},
    destroy(){onVolumes([]);onCells([]);clearInterval(timer);map.off("moveend",update);if(map.getLayer(layer))map.removeLayer(layer);if(map.getSource(source))map.removeSource(source);},
  };
}
