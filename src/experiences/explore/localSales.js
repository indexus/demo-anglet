// A bounded local extract, read through the shared SDK session. No national DVF layer.
import { DVF_COLLECTION } from '../../data/dvf.js';
import { addSaleLabels, saleReadings } from './saleLabels.js';
export function localSaleData(records,scene){
 const points=[],metrics=[],keys=[];
 const [lon,lat]=scene.origin,scale=Math.PI*6378137/180,cos=Math.cos(lat*Math.PI/180);
 for(const row of records){
  const m=row.metrics;if(!m||m.length<5||!(m[0]>0&&m[1]>0&&m[2]>0))continue;
  const y=(m[3]-90-lat)*scale,x=(m[4]-180-lon)*scale*cos;
  if(x*x+y*y>(scene.radius??150)**2)continue;
  points.push(m[4]-180,m[3]-90,m[2]);metrics.push(m);keys.push(row.id);
 }
 return {points:new Float64Array(points),metrics,keys};
}
export async function addLocalSales({map,network,scene,geometry,isVisible,project}){
 const records=await network.getContentRecords(DVF_COLLECTION.name,'@',128);
 const data=localSaleData(records,scene),readings=saleReadings(data.points,data.metrics,data.keys);
 const labels=addSaleLabels(map,project,(building,color)=>geometry.highlightBuilding(building,color));
 labels.update(data.points,data.metrics,data.keys);
 let enabled=true,last=null;
 const sync=()=>{const visible=enabled&&isVisible();if(visible!==last){last=visible;labels.setVisible(visible);}};
 map.on('render',sync);geometry.setSales(readings);sync();
 return {setEnabled(value){enabled=value;geometry.setSales(value?readings:[]);sync();},destroy(){map.off('render',sync);labels.destroy();geometry.setSales([]);},readings};
}
