import { insideRing } from "../point-cloud/geometry.js";
import { boxCorners } from "../point-cloud/buildingsTree.js";
// A result and a rendered leaf share an Indexus location, not a nearest-centre guess.
export function nearbyBuilding(tree, row) {
  let match;
  if (!row?.location) return null;
  for (const zone of tree.zones.values()) for (const leaf of zone.leaves.values()) {
    if (row.location.startsWith(leaf.location) && (!match || leaf.location.length > match.location.length)) match = leaf;
  }
  return match ?? null;
}
export function nearbyRoofColors(tree, rows, latestCount, selectedId) {
  const colors = new Map();
  for (const [index, row] of rows.entries()) {
    const leaf = nearbyBuilding(tree, row);
    if (leaf) colors.set(leaf.location, row.id === selectedId ? [245,217,71] : index >= rows.length-latestCount ? [237,139,32] : [34,120,180]);
  }
  return colors;
}

export function nearbyGeometryDetails(tree, row, surface, altitude) {
  const leaf = nearbyBuilding(tree, row);
  if (!leaf || !surface) return null;
  const ground = surface.height(leaf.box.centre);
  return { location: leaf.location, ground: ground+altitude, roof: leaf.box.roof+altitude,
    height: leaf.box.roof-ground, area: leaf.box.area };
}

/** UI picking against loaded roof boxes in screen space; not a mesh-triangle hit test. */
export function pickNearbyRoof(tree, rows, point, matrix, width, height) {
  const project = ([x,y], z) => {
    const w=matrix[3]*x+matrix[7]*y+matrix[11]*z+matrix[15];
    if(w<=0)return null;
    const u=(matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12])/w;
    const v=(matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13])/w;
    const depth=(matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14])/w;
    if(depth < -1 || depth > 1)return null;
    return {x:(u+1)*width/2,y:(1-v)*height/2,depth};
  };
  let hit;
  for(const row of rows){
    const leaf=nearbyBuilding(tree,row);
    if(!leaf)continue;
    const corners=boxCorners(leaf.box).map(p=>project(p,leaf.box.roof));
    if(corners.some(p=>!p)||!insideRing([point.x,point.y],corners.map(p=>[p.x,p.y])))continue;
    const roof=project(leaf.box.centre,leaf.box.roof);
    if(roof&&(!hit||roof.depth<hit.point.depth))hit={row,point:roof};
  }
  return hit??null;
}
