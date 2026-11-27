import { createGuidedExperience, GUIDE_VIEWS } from "./guidedExperience.js";
import { createMapAddresses } from "./mapAddresses.js";
import { createGridHosting } from "./gridHosting.js";
import { createCollectionGrid } from "./collectionGrid.js";
import { createNearbySceneSearch } from "../../data/nearby.js";
import { createNearbyOverlay } from "./nearbyOverlay.js";
import "./scenePanel.css";

export function createScenePanel({ map, guided = false, visitLocal = () => {}, visitOverview = () => {}, getScene, getNetwork, setLayerVisible, setNearby, pickNearby, getNearbyDetails, getLoadedGrid, setGridCells, projectGridCell = () => null }) {
  const host=document.createElement("aside");
  host.className="scene-collections";
  host.setAttribute("aria-label","Scene layers and nearby buildings");
  host.innerHTML=`<button class="scene-collections-toggle" aria-expanded="true" hidden>Layers</button>
    <section class="scene-collections-panel">
      <header><strong>Layers</strong><button class="scene-collections-close" aria-label="Collapse panel">−</button></header>
      <div class="scene-experiences" hidden></div>
      <div class="scene-panel-collections"></div>
      <div class="scene-grid-settings" hidden>
        <label class="scene-grid-density"><span>Grid density <output>96 cells</output></span><input type="range" min="16" max="320" value="96" step="8" aria-label="Grid density"></label>
        <p class="scene-grid-help">More cells add detail. Colours show which node stores them.</p>
        <details class="scene-grid-advanced"><summary>Depth limit</summary><label class="scene-grid-resolution"><span>Cell depth <output>0 / 0</output></span><input type="range" min="0" max="0" value="0" step="1" aria-label="Grid depth" title="Limits cell depth while density caps the number drawn; only actual loaded cells are used"></label></details>
        <div class="scene-grid-node-legend"></div>
      </div>
      <div class="scene-nearby-controls"><span class="scene-panel-count" role="status">0 buildings</span><button class="scene-panel-next" title="Find the first 5 nearby buildings">Search</button><button class="scene-panel-reset" aria-label="Refresh nearby buildings" title="Restart from the scene centre" disabled>↻</button></div>
      <details class="scene-panel-sources"><summary aria-label="Sources and building details">ⓘ</summary><p class="scene-hover-details" hidden></p><p>Anglet · 1 km sample. Distances are from the scene centre to indexed locations. Hover uses approximate roof bounds. Nearby roof colours: blue for earlier results, orange for new results and yellow for the hovered roof. LiDAR geometry, aerial imagery and AROME forecast archive, 28–30 Jan 2025. DVF 2020: local geocoded house sales in this 1 km scene, approximate roof association, not current property valuations. Not cadastral measurements or weather sensors on buildings.</p></details>
    </section>`;
  const sources=host.querySelector('.scene-panel-sources');
  sources.insertAdjacentHTML('beforeend','<p>Temperature covers mainland France at reduced detail, with native detail around Anglet. Archived AROME data: <a href="https://meteofrance.fr/" target="_blank" rel="noopener noreferrer">Météo-France</a> via <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>. Indexus crops and aggregates the prepared series.</p>');
  document.body.append(host);
  const find=s=>host.querySelector(s),toggle=find(".scene-collections-toggle"),panel=find("section");
  const next=find(".scene-panel-next"),refresh=find(".scene-panel-reset"),count=find(".scene-panel-count");
  const overlay=createNearbyOverlay(map),container=map.getContainer();
  const resolution=find(".scene-grid-settings"),slider=find(".scene-grid-resolution input"),depthLabel=find(".scene-grid-resolution output"),visibleGrids=new Set();
  const density=find(".scene-grid-density input"),densityLabel=find(".scene-grid-density output");
  const hosting=createGridHosting();
  const addresses=createMapAddresses({map,getSnapshot:()=>hosting.snapshot(),projectCube:projectGridCell,legendHost:find(".scene-grid-node-legend")});
  const grid=createCollectionGrid(map,getLoadedGrid,({depth,maxDepth,zones,budget})=>{
    addresses.setVisible(visibleGrids.size>0);
    density.value=String(budget??96);densityLabel.value=zones+" cells";density.setAttribute("aria-valuetext","Limit "+(budget??96)+" cells; "+zones+" shown");
    slider.max=String(maxDepth);slider.value=String(depth);slider.disabled=maxDepth===0;
    slider.setAttribute("aria-valuetext",`Depth ${depth} of ${maxDepth}`);depthLabel.value=depth+" / "+maxDepth;
  },setGridCells,()=>hosting.snapshot(),cells=>addresses.setCells(cells));
  density.oninput=()=>grid.setDensity(Number(density.value));
  slider.oninput=()=>grid.setResolution(Number(slider.value));
  const tooltip=document.createElement("div");tooltip.className="scene-roof-distance";tooltip.hidden=true;container.append(tooltip);
  const navigation=container.querySelector(".scene-navigation");
  if(navigation){
    navigation.prepend(toggle);
    toggle.setAttribute("aria-label","Layers and experiences");toggle.title="Layers and experiences";
    toggle.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/></svg>';
  }
  panel.id="scene-layers-panel";toggle.setAttribute("aria-controls",panel.id);
  const layerControls=new Map();let guide=null;
  function showGrid(role,show){
    const control=layerControls.get(role);if(!control)return;
    show=show&&control.check.checked&&role!=="dvf";
    control.eye.setAttribute("aria-pressed",String(show));
    if(show)visibleGrids.add(role);else visibleGrids.delete(role);
    resolution.hidden=!visibleGrids.size;grid.toggle(role,show);
  }
  function showLayer(role,show){
    const control=layerControls.get(role);if(!control)return;
    control.check.checked=show;control.eye.disabled=!show;setLayerVisible(role,show);
    if(!show)showGrid(role,false);hideHover();
  }
  const place=()=>{
    if(!navigation)return;
    const bounds=navigation.getBoundingClientRect();
    host.style.top=`${bounds.bottom+10}px`;host.style.right=`${innerWidth-bounds.right}px`;
  };
  const observer=new ResizeObserver(place);
  if(navigation)observer.observe(navigation);
  window.addEventListener("resize",place);place();
  let walk,rows=[],frontiers=[],latestCount=0,hoveredId=null,busy=false,exhausted=false,disposed=false,hoverFrame=0;
  function open(value){panel.hidden=!value;toggle.hidden=false;toggle.setAttribute("aria-expanded",String(value));toggle.setAttribute("aria-pressed",String(value));}
  toggle.onclick=()=>open(panel.hidden);find(".scene-collections-close").onclick=()=>open(false);
  for(const [role,label] of [["terrain","Terrain"],["ortho","Aerial photo"],["buildings","Buildings"],["vegetation","Vegetation"],["weather","Weather"],["dvf","Sales · 2020"]]){
    const row=document.createElement("div");row.className="scene-layer-row";
    const labelElement=document.createElement("label");
    const check=document.createElement("input");check.type="checkbox";check.checked=true;
    const title=document.createElement("span");title.textContent=label;labelElement.append(title,check);
    const eye=document.createElement("button");eye.className="scene-grid-eye";eye.setAttribute("aria-label",`Show loaded ${label.toLowerCase()} cells`);eye.setAttribute("aria-pressed","false");eye.title=role==="weather"?"Temperature cube: nonempty read zones used by the current view":"Loaded collection cells · ground footprint";
    eye.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    eye.onclick=()=>showGrid(role,eye.getAttribute("aria-pressed")!=="true");
    eye.hidden=role==="dvf";
    row.append(labelElement,eye);find(".scene-panel-collections").append(row);
    layerControls.set(role,{check,eye});
    check.onchange=()=>showLayer(role,check.checked);
  }
  open(false);
  if(guided){
    const legend=find(".scene-grid-node-legend");
    guide=createGuidedExperience({container,layer:showLayer,resizeView:()=>map.resize(),
      grid(role,show){showGrid(role,show);if(show)grid.setDensity(64);},
      view(value){open(false);if(value==="overview")visitOverview();else visitLocal();},
      networkLegend(target){(target??resolution).append(legend);},
    });
    const experiments=find(".scene-experiences");experiments.hidden=false;
    for(const {label,step:index} of GUIDE_VIEWS){
      const button=document.createElement("button");button.type="button";button.textContent=label;
      button.onclick=()=>{guide.select(index,{reframe:true});open(false);};experiments.append(button);
    }
    const requested = new URLSearchParams(window.location.search).get("view");
    guide.select(GUIDE_VIEWS.find(view => view.name === requested)?.step ?? 0);
  }
  function hideHover(){
    tooltip.hidden=true;
    if(hoveredId!==null){hoveredId=null;overlay.select(null);setNearby(rows,latestCount);}
  }
  function hover(event){
    cancelAnimationFrame(hoverFrame);
    hoverFrame=requestAnimationFrame(()=>{
      if(disposed)return;
      const hit=pickNearby(event.point);
      if(!hit){hideHover();return;}
      tooltip.textContent=`${Math.round(hit.row.metres)} m`;
      tooltip.style.left=`${hit.point.x}px`;tooltip.style.top=`${hit.point.y-12}px`;tooltip.hidden=false;
      if(hoveredId!==hit.row.id){
        hoveredId=hit.row.id;overlay.select(hit.row);setNearby(rows,latestCount,hoveredId);
        const details=getNearbyDetails(hit.row),info=find(".scene-hover-details");
        info.hidden=!details;
        if(details){
          const weather=details.weather;
          info.textContent=`Hovered building: ≈ ${details.height.toFixed(1)} m high · ${Math.round(details.area)} m² footprint. Roof ${details.roof.toFixed(1)} m / ground ${details.ground.toFixed(1)} m altitude.`+(weather?` AROME ${new Date(details.date).toLocaleString("en-GB")}: clouds ${Math.round(weather.clouds)}%, rain ≈ ${(weather.observedRain??weather.rain).toFixed(2)} mm/h.`:"");
        }
      }
    });
  }
  const leave=()=>{cancelAnimationFrame(hoverFrame);hideHover();};
  map.on("mousemove",hover);map.on("movestart",leave);container.addEventListener("mouseleave",leave);host.addEventListener("pointerenter",leave);
  async function readPage(restart){
    if(busy||disposed)return;
    busy=true;next.disabled=refresh.disabled=true;count.textContent="Loading…";leave();
    if(restart){walk=null;rows=[];frontiers=[];latestCount=0;exhausted=false;setNearby([],0);overlay.clear();}
    try{
      if(!walk)walk=createNearbySceneSearch(await getNetwork(),getScene());
      const page=await walk.next(5);
      if(disposed)return;
      rows.push(...page);latestCount=page.length;if(page.length)frontiers.push(page.at(-1).metres);
      setNearby(rows,latestCount);overlay.show(getScene().origin,rows,frontiers,getScene().radius,page.length);
      exhausted=!page.length;count.textContent=`${rows.length} buildings`;count.title=exhausted?"All results within this sample":"Ordered by distance from the scene centre";
    }catch{count.textContent="Retry ↻";}
    finally{busy=false;if(!disposed){next.disabled=exhausted;refresh.disabled=!walk;next.textContent=rows.length?"Next":"Search";next.title=rows.length?"Show the next 5 farther buildings":"Find the first 5 nearby buildings";}}
  }
  next.onclick=()=>readPage(false);refresh.onclick=()=>readPage(true);
  return {destroy(){disposed=true;cancelAnimationFrame(hoverFrame);observer.disconnect();window.removeEventListener("resize",place);map.off("mousemove",hover);map.off("movestart",leave);container.removeEventListener("mouseleave",leave);setNearby([],0);guide?.destroy();toggle.remove();grid.destroy();addresses.destroy();hosting.destroy();overlay.destroy();tooltip.remove();host.remove();}};
}
