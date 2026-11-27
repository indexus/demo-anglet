const SOURCE = "indexus-nearby-demo";
const LAYERS = ["scene-nearby-rings", "scene-nearby-points", "scene-nearby-ranks", "scene-nearby-distances"];

/** Geodesic distance rings, independent of the scene's Mercator scale. */
export function distanceRing([lng,lat],metres,segments=80) {
  const a=lat*Math.PI/180,b=lng*Math.PI/180,d=metres/6371000;
  return Array.from({length:segments+1},(_,i)=>{
    const bearing=i/segments*Math.PI*2;
    const p=Math.asin(Math.sin(a)*Math.cos(d)+Math.cos(a)*Math.sin(d)*Math.cos(bearing));
    const q=b+Math.atan2(Math.sin(bearing)*Math.sin(d)*Math.cos(a),Math.cos(d)-Math.sin(a)*Math.sin(p));
    return [q*180/Math.PI,p*180/Math.PI];
  });
}
export function nearbyFeatures(origin,rows,frontiers,radius,latestCount=0) {
  const features=[{type:"Feature",geometry:{type:"Point",coordinates:origin},properties:{origin:true,rank:0}}];
  for(const [index,r] of [radius,...frontiers].entries()) {
    const coordinates=distanceRing(origin,r),properties={current:index===frontiers.length,coverage:index===0,radius:r};
    features.push({type:"Feature",geometry:{type:"LineString",coordinates},properties:{...properties,ring:true}});
    features.push({type:"Feature",geometry:{type:"Point",coordinates:coordinates[(10+index*19)%80]},properties:{...properties,distanceLabel:true}});
  }
  for(const [index,row] of rows.entries()) features.push({type:"Feature",id:row.id,geometry:{type:"Point",coordinates:row.coordinates},properties:{rank:index+1,current:index>=rows.length-latestCount,recordId:row.id}});
  return {type:"FeatureCollection",features};
}
export function createNearbyOverlay(map) {
  map.addSource(SOURCE,{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:LAYERS[0],type:"line",source:SOURCE,filter:["==",["geometry-type"],"LineString"],paint:{"line-color":["case",["get","coverage"],"#667b85",["get","current"],"#ed8b20","#2278b4"],"line-width":["case",["get","current"],3,1.3],"line-opacity":["case",["get","coverage"],.3,.9]}});
  map.addLayer({id:LAYERS[1],type:"circle",source:SOURCE,filter:["all",["==",["geometry-type"],"Point"],["!",["boolean",["get","distanceLabel"],false]]],paint:{"circle-radius":["case",["get","origin"],6,16],"circle-color":["case",["boolean",["feature-state","selected"],false],"#f5d947",["get","current"],"#ed8b20","#2278b4"],"circle-stroke-color":"#fff","circle-stroke-width":2.5}});
  map.addLayer({id:LAYERS[2],type:"symbol",source:SOURCE,filter:[">",["get","rank"],0],layout:{"text-field":["to-string",["get","rank"]],"text-size":14,"text-allow-overlap":true,"text-ignore-placement":true},paint:{"text-color":"#fff"}});
  map.addLayer({id:LAYERS[3],type:"symbol",source:SOURCE,filter:["==",["get","distanceLabel"],true],layout:{"text-field":["concat",["to-string",["round",["get","radius"]]]," m"],"text-size":12,"text-allow-overlap":false,"text-padding":5},paint:{"text-color":["case",["get","current"],"#a85308","#275d7c"],"text-halo-color":"#fffffff2","text-halo-width":2}});
  let selected;
  return {
    show(origin,rows,frontiers,radius,latestCount=0) {for(const id of LAYERS)map.moveLayer(id);map.getSource(SOURCE)?.setData(nearbyFeatures(origin,rows,frontiers,radius,latestCount));},
    select(row) {if(selected)map.setFeatureState({source:SOURCE,id:selected},{selected:false});selected=row?.id;if(selected)map.setFeatureState({source:SOURCE,id:selected},{selected:true});},
    clear(){map.getSource(SOURCE)?.setData({type:"FeatureCollection",features:[]});},
    destroy(){for(const id of [...LAYERS].reverse())if(map.getLayer(id))map.removeLayer(id);if(map.getSource(SOURCE))map.removeSource(SOURCE);},
  };
}
