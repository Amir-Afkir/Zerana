import * as THREE from 'three';

/** Per-cell ownership: the terrain root supplies visibility and rebase, while
 * its resource set supplies final disposal. No independent road coordinates. */
export class RoadSurfaceView {
  constructor(view) { this.view = view; }
  stage(cell, packet) {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,metalness:0,
      polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,depthTest:true,depthWrite:true});
    try {
      geometry.setAttribute('position',new THREE.BufferAttribute(packet.positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(packet.normals,3));
      geometry.setAttribute('color',new THREE.BufferAttribute(packet.colors,3));
      geometry.setAttribute('uv',new THREE.BufferAttribute(packet.uvs,2));
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry,material);mesh.visible=false;mesh.renderOrder=2;
      cell.root.add(mesh);
      for(const resource of [geometry,material]){this.view.own(resource);cell.resources.add(resource);}
      return {cell,packet,mesh,geometry,material,disposed:false};
    } catch(error) {geometry.dispose();material.dispose();throw error;}
  }
  compile(handle) {return this.view.renderer.compileAsync(handle.mesh,this.view.camera,this.view.scene);}
  warm(handle) {if(handle.packet.triangleCount)this.view.warmMesh(handle.mesh);}
  commit(handle) {
    if(handle.disposed||this.view.findCell(handle.cell.packet.id)!==handle.cell)throw new Error('ROAD_STALE_RENDER_CELL');
    this.remove(handle.cell.roadSurface);
    handle.cell.roadSurface=handle;handle.mesh.visible=true;
  }
  remove(handle) {
    if(!handle||handle.disposed)return;
    handle.disposed=true;handle.mesh.removeFromParent();
    for(const resource of [handle.geometry,handle.material]){
      // A terrain eviction may already have released these resources.
      if(handle.cell.resources.has(resource)&&this.view.resources.has(resource))resource.dispose();
      handle.cell.resources.delete(resource);this.view.resources.delete(resource);
    }
    if(handle.cell.roadSurface===handle)handle.cell.roadSurface=null;
  }
}
