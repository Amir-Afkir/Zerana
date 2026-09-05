import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createGeoAnchor } from '../../src/geo/enu.ts';
import { ecefToGeodetic } from '../../src/geo/ecef.ts';
import { frameTransform, transformPoint } from '../../src/geo/floating-origin.ts';
import { ecefToThreeLocal } from '../../src/geo/three-frame.ts';

const MARKER_HEIGHT_METERS=1.8;
function applyFrame(object,transform){
  const r=transform.rotation,t=transform.translationMeters;
  object.matrixAutoUpdate=false;
  object.matrix.set(r[0],r[1],r[2],t[0],r[3],r[4],r[5],t[1],r[6],r[7],r[8],t[2],0,0,0,1);
  object.matrixWorldNeedsUpdate=true;
}
function vector(point){return new THREE.Vector3(...point);}
function checkerTexture(){
  const size=128,data=new Uint8Array(size*size*4);
  for(let row=0;row<size;row++)for(let col=0;col<size;col++){
    let color=((row>>4)+(col>>4))%2?[63,95,106]:[84,124,132];
    // DataTexture row 0 is v=0 (south). North is the high-v row.
    if(col<8&&row>=size-8)color=[237,88,73];
    if(col>=size-8&&row>=size-8)color=[78,151,244];
    if(col<8&&row<8)color=[247,201,72];
    if(col>=size-8&&row<8)color=[239,245,251];
    data.set([...color,255],(row*size+col)*4);
  }
  const texture=new THREE.DataTexture(data,size,size);
  texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;
  texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.LinearFilter;
  texture.generateMipmaps=false;texture.needsUpdate=true;return texture;
}

/** All Three.js ownership stays inside this render adapter. No providers or scheduling. */
export class TerrainView{
  constructor(container,onError){
    this.container=container;this.onError=onError;this.disposed=false;
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#101820');
    this.camera=new THREE.PerspectiveCamera(50,1,0.05,20000);
    this.renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label','Terrain synthétique métrique');
    container.appendChild(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;
    this.controls.minDistance=1;this.controls.maxDistance=15000;
    this.scene.add(new THREE.HemisphereLight(0xe8f4ff,0x273948,2));
    const light=new THREE.DirectionalLight(0xffffff,2.2);light.position.set(1000,1800,600);this.scene.add(light);
    this.patchRoot=new THREE.Group();this.scene.add(this.patchRoot);this.resources=new Set();this.cellViews=[];
    this.resize=()=>{
      const width=Math.max(1,container.clientWidth),height=Math.max(1,container.clientHeight);
      this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.renderer.setSize(width,height);
    };
    this.observer=new ResizeObserver(this.resize);this.observer.observe(container);this.resize();
    this.contextLost=event=>{event.preventDefault();onError('Contexte WebGL perdu. Recharge la page pour reconstruire la démo.');};
    this.renderer.domElement.addEventListener('webglcontextlost',this.contextLost);
    this.animate=now=>{
      if(this.disposed)return;
      const dt=this.previousTime===undefined?0:Math.max(0,(now-this.previousTime)/1000);this.previousTime=now;
      this.onBeforeFrame?.(dt);
      this.onFrame?.(dt);
      if(this.controls.enabled)this.controls.update();
      this.render();this.frame=requestAnimationFrame(this.animate);
    };
    this.animate(performance.now());
  }
  own(resource){this.resources.add(resource);return resource;}
  clearPatch(){
    this.patchRoot.clear();for(const resource of this.resources)resource.dispose();this.resources.clear();
    this.cellViews=[];this.markerRoot=null;this.grid=null;
  }
  setPatch(packets,world,markerEcef,imagery=new Map()){
    this.clearPatch();this.world=world;this.markerEcef=markerEcef;
    this.texture=this.own(checkerTexture());
    this.surfaceMaterial=this.own(new THREE.MeshStandardMaterial({map:this.texture,roughness:1,metalness:0}));
    this.normalMaterial=this.own(new THREE.MeshNormalMaterial());
    const wireMaterial=this.wireMaterial=this.own(new THREE.LineBasicMaterial({color:0x86c8b6,transparent:true,opacity:0.23}));
    const borderMaterial=this.borderMaterial=this.own(new THREE.LineBasicMaterial({color:0x90f0cc}));
    for(const packet of packets)this.addCell(packet,imagery.get(`${packet.id.level}/${packet.id.x}/${packet.id.y}`));
    this.markerAnchor=createGeoAnchor(ecefToGeodetic(markerEcef));this.markerRoot=new THREE.Group();
    const capsule=new THREE.Mesh(this.own(new THREE.CapsuleGeometry(0.25,MARKER_HEIGHT_METERS-0.5,4,12)),
      this.own(new THREE.MeshStandardMaterial({color:0xffc768,roughness:0.7})));
    capsule.position.y=MARKER_HEIGHT_METERS/2;this.markerRoot.add(capsule);
    this.grid=new THREE.GridHelper(100,20,0x63839a,0x314858);this.grid.position.y=0.015;
    this.own(this.grid.geometry);this.own(this.grid.material);this.markerRoot.add(this.grid);
    const axes=new THREE.AxesHelper(10);this.own(axes.geometry);this.own(axes.material);this.markerRoot.add(axes);
    applyFrame(this.markerRoot,frameTransform(this.markerAnchor,world));this.patchRoot.add(this.markerRoot);
    this.scene.updateMatrixWorld(true);
  }
  addCell(packet,imagePacket,{visible=true}={}){
    if(this.cellViews.some(c=>c.packet.id.level===packet.id.level&&c.packet.id.x===packet.id.x&&c.packet.id.y===packet.id.y))throw new Error('DUPLICATE_RENDER_CELL');
    const resources=new Set();
    const own=resource=>{resources.add(resource);this.own(resource);return resource;};
    try{
      const geometry=own(new THREE.BufferGeometry());
      geometry.setAttribute('position',new THREE.BufferAttribute(packet.positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(packet.normals,3));
      geometry.setAttribute('uv',new THREE.BufferAttribute(packet.uvs,2));
      geometry.setIndex(new THREE.BufferAttribute(packet.indices,1));geometry.computeBoundingBox();geometry.computeBoundingSphere();
      let surfaceMaterial=this.surfaceMaterial;
      const image=imagePacket;
      if(image){
        const texture=own(new THREE.DataTexture(image.rgba,image.width,image.width));
        texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;texture.generateMipmaps=false;
        texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
        texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;
        texture.repeat.setScalar(image.uvScale);texture.offset.setScalar(image.uvOffset);texture.needsUpdate=true;
        surfaceMaterial=own(new THREE.MeshStandardMaterial({map:texture,roughness:1,metalness:0}));
      }
      const root=new THREE.Group(),mesh=new THREE.Mesh(geometry,surfaceMaterial);root.visible=visible;
      const wire=new THREE.LineSegments(own(new THREE.WireframeGeometry(geometry)),this.wireMaterial);
      const border=[];const n=packet.subdivisions,w=n+1;
      const add=i=>border.push(packet.positions[i*3],packet.positions[i*3+1],packet.positions[i*3+2]);
      for(let col=0;col<=n;col++)add(col);
      for(let row=1;row<=n;row++)add(row*w+n);
      for(let col=n-1;col>=0;col--)add(n*w+col);
      for(let row=n-1;row>0;row--)add(row*w);
      const edgeGeometry=own(new THREE.BufferGeometry());edgeGeometry.setAttribute('position',new THREE.Float32BufferAttribute(border,3));
      root.add(mesh,wire,new THREE.LineLoop(edgeGeometry,this.borderMaterial));
      applyFrame(root,frameTransform(packet.anchor,this.world));this.patchRoot.add(root);
      this.cellViews.push({packet,root,mesh,wire,surfaceMaterial,resources});
      this.setModes(this.modes || {wireframe:true,normals:false,metricGrid:false});
    }catch(error){for(const resource of resources){resource.dispose();this.resources.delete(resource);}throw error;}
  }
  setVisibleCells(ids){
    const key=id=>`${id.level}/${id.x}/${id.y}`;
    const keys=new Set(ids.map(key)), resident=new Set(this.cellViews.map(c=>key(c.packet.id)));
    if(!keys.size || [...keys].some(k=>!resident.has(k)))throw new Error('VISIBLE_CELL_NOT_RESIDENT');
    for(const cell of this.cellViews)cell.root.visible=keys.has(key(cell.packet.id));
  }
  removeCell(id){
    const cell=this.cellViews.find(c=>c.packet.id.level===id.level&&c.packet.id.x===id.x&&c.packet.id.y===id.y);
    if(!cell)return;
    cell.root.removeFromParent();
    for(const resource of cell.resources){resource.dispose();this.resources.delete(resource);}
    this.cellViews=this.cellViews.filter(c=>c!==cell);
  }
  setModes({wireframe,normals,metricGrid}){
    this.modes={wireframe,normals,metricGrid};
    for(const cell of this.cellViews){cell.wire.visible=wireframe;cell.mesh.material=normals?this.normalMaterial:cell.surfaceMaterial;}
    if(this.grid)this.grid.visible=metricGrid;
  }
  overview(){
    const bounds=new THREE.Box3();this.scene.updateMatrixWorld(true);
    for(const cell of this.cellViews)if(cell.root.visible)bounds.expandByObject(cell.mesh);
    if(bounds.isEmpty())return;
    const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
    const extent=Math.max(size.x,size.y,size.z,10);
    this.camera.up.set(0,1,0);this.camera.position.copy(center).add(new THREE.Vector3(extent*.8,extent*.85,extent*.95));
    this.controls.target.copy(center);this.controls.update();
  }
  humanView(){
    if(!this.markerAnchor)return;
    const frame=frameTransform(this.markerAnchor,this.world);
    this.camera.up.copy(vector([frame.rotation[1],frame.rotation[4],frame.rotation[7]]));
    this.camera.position.copy(vector(transformPoint([4,3,5],frame)));
    this.controls.target.copy(vector(transformPoint([0,0.9,0],frame)));this.controls.update();
  }
  rebase(next){
    const transform=frameTransform(this.world,next);
    const rotation=new THREE.Matrix4(),r=transform.rotation;
    rotation.set(r[0],r[1],r[2],0,r[3],r[4],r[5],0,r[6],r[7],r[8],0,0,0,0,1);
    this.camera.position.copy(vector(transformPoint(this.camera.position.toArray(),transform)));
    this.controls.target.copy(vector(transformPoint(this.controls.target.toArray(),transform)));
    this.camera.up.transformDirection(rotation);
    this.world=next;
    for(const cell of this.cellViews)applyFrame(cell.root,frameTransform(cell.packet.anchor,next));
    applyFrame(this.markerRoot,frameTransform(this.markerAnchor,next));
    if(this.controls.enabled)this.controls.update();this.scene.updateMatrixWorld(true);
  }
  render(){if(!this.disposed)this.renderer.render(this.scene,this.camera);}
  snapshot(){
    this.scene.updateMatrixWorld(true);this.camera.updateMatrixWorld(true);
    const marker=this.markerEcef?vector(ecefToThreeLocal(this.markerEcef,this.world)):new THREE.Vector3();
    const projected=marker.clone().project(this.camera);
    return {geometries:this.renderer.info.memory.geometries,textures:this.renderer.info.memory.textures,
      drawCalls:this.renderer.info.render.calls,altitudeAuthority:this.cellViews[0]?.packet.altitudeAuthority,
      texturedCells:this.cellViews.filter(cell=>cell.surfaceMaterial!==this.surfaceMaterial).length,markerHeightMeters:MARKER_HEIGHT_METERS,
      markerEcef:this.markerEcef,markerNdc:projected.toArray(),
      geometryIds:this.cellViews.map(cell=>cell.mesh.geometry.uuid),
      cellResources:this.cellViews.map(cell=>({key:`web-mercator/${cell.packet.id.level}/${cell.packet.id.x}/${cell.packet.id.y}`,
        visible:cell.root.visible,geometryId:cell.mesh.geometry.uuid})),
      bufferFirstVertices:this.cellViews.map(cell=>Array.from(cell.packet.positions.slice(0,3)))};
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.frame);
    this.observer.disconnect();this.controls.dispose();
    this.renderer.domElement.removeEventListener('webglcontextlost',this.contextLost);
    this.clearPatch();this.renderer.dispose();this.renderer.forceContextLoss();this.renderer.domElement.remove();
  }
}
