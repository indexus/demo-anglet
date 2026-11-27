// Retained XYZ cell bounds, in the scene frame. One instanced wire cube per cell.
import { DEPTH_FORMAT, gpuMatrix } from "../../rendering/gpu/engine.js";
const SHADER=/* wgsl */`
struct View { matrix: mat4x4f, color: vec4f }
@group(0) @binding(0) var<uniform> view: View;
struct VertexOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) color: vec3f }
@vertex fn vertex(@builtin(vertex_index) index: u32,
                  @location(0) lo: vec3f, @location(1) hi: vec3f, @location(2) color: vec3f) -> VertexOut {
  let edges=array<u32,24>(0u,1u,1u,3u,3u,2u,2u,0u,4u,5u,5u,7u,7u,6u,6u,4u,0u,4u,1u,5u,2u,6u,3u,7u);
  let corner=edges[index];
  let side=vec3f(f32(corner&1u),f32((corner>>1u)&1u),f32((corner>>2u)&1u));
  var out: VertexOut; out.position=view.matrix*vec4f(mix(lo,hi,side),1.0); out.color=color; return out;
}
@fragment fn fragment(input: VertexOut) -> @location(0) vec4f { return vec4f(input.color*view.color.a,view.color.a); }
`;
/** Nine floats per instance (bounds and storage-node colour); no CPU expansion of edges or invented height. */
export function cellGridInstances(cells){
  const data=new Float32Array(cells.length*9);
  for(let i=0;i<cells.length;i++){data.set(cells[i].volume.min,i*9);data.set(cells[i].volume.max,i*9+3);const color=parseInt((cells[i].color??"#2ebf6b").slice(1),16);data[i*9+6]=((color>>16)&255)/255;data[i*9+7]=((color>>8)&255)/255;data[i*9+8]=(color&255)/255;}
  return data;
}
export class CellGridLayer {
  id="scene-cell-grid";
  type="custom";
  renderingMode="3d";
  constructor(getFrame,engine){this.getFrame=getFrame;this.engine=engine;this.cells=[];this.signature=null;this.count=0;this.capacity=0;this.view=new Float32Array(20);}
  onAdd(map){this.map=map;if(this.cells.length)this.setCells(this.cells);}
  initialize(){
    this.signature=null;this.capacity=0;const device=this.engine.device,module=device.createShaderModule({code:SHADER});
    this.uniform=device.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createRenderPipeline({layout:"auto",vertex:{module,entryPoint:"vertex",buffers:[{arrayStride:36,stepMode:"instance",attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x3"}]}]},fragment:{module,entryPoint:"fragment",targets:[{format:this.engine.format,blend:{color:{srcFactor:"one",dstFactor:"one-minus-src-alpha"},alpha:{srcFactor:"one",dstFactor:"one-minus-src-alpha"}}}]},primitive:{topology:"line-list"},depthStencil:{format:DEPTH_FORMAT,depthWriteEnabled:false,depthCompare:"less-equal"}});
    this.binding=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}}]});
  }
  setCells(cells){
    this.cells=cells;if(!this.map)return;
    if(!this.pipeline){if(!cells.length)return;this.initialize();}
    const signature=cells.map(cell=>cell.id+"/"+(cell.color??"")).sort().join("|");
    if(signature===this.signature)return;this.signature=signature;this.count=cells.length;
    if(this.count){
      const data=cellGridInstances(cells);
      if(data.byteLength>this.capacity){this.buffer?.destroy();this.capacity=2**Math.ceil(Math.log2(Math.max(32,data.byteLength)));this.buffer=this.engine.device.createBuffer({size:this.capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}
      this.engine.device.queue.writeBuffer(this.buffer,0,data);
    }
    this.map?.triggerRepaint();
  }
  render(){
    const frame=this.getFrame();
    if(!this.count||!frame?.viewMatrix||frame.hidden||globalThis.document?.hidden)return;
    gpuMatrix(frame.viewMatrix,this.view);this.view.set([.18,.75,.42,.8*(frame.sceneOpacity??1)],16);
    this.engine.device.queue.writeBuffer(this.uniform,0,this.view);
    this.engine.add("cell-grid",pass=>{pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.binding);pass.setVertexBuffer(0,this.buffer);pass.draw(24,this.count);},{stage:"effects"});
  }
  onRemove(){this.buffer?.destroy();this.uniform?.destroy();this.buffer=this.uniform=null;this.count=0;this.capacity=0;this.signature=null;this.pipeline=null;this.map=null;}
}
