import * as THREE from 'three';
export function waterMaterial(){
  return new THREE.ShaderMaterial({uniforms:{waterTime:{value:0}},depthTest:true,depthWrite:true,transparent:false,
    vertexShader:`varying vec2 waterUv;varying vec3 waterNormal;varying vec3 waterView;
      void main(){waterUv=uv;waterNormal=normalize(normalMatrix*normal);vec4 p=modelViewMatrix*vec4(position,1.0);waterView=-p.xyz;gl_Position=projectionMatrix*p;}`,
    fragmentShader:`uniform float waterTime;varying vec2 waterUv;varying vec3 waterNormal;varying vec3 waterView;
      void main(){float x=6.28318530718*waterUv.x;float y=6.28318530718*waterUv.y;
        vec3 n=normalize(waterNormal+vec3(.045*sin(x+waterTime*.65)+.025*sin(y-waterTime*.4),.025*cos(x-y),.04*cos(y+waterTime*.5)));
        vec3 eye=normalize(waterView);float fresnel=.04+.75*pow(1.0-max(0.0,dot(n,eye)),5.0);
        vec3 deep=vec3(.016,.115,.15);vec3 sky=vec3(.32,.50,.57);
        float sun=pow(max(0.0,dot(n,normalize(eye+normalize(vec3(-.5,.8,1.0))))),96.0);
        gl_FragColor=vec4(mix(deep,sky,fresnel)+vec3(.35)*sun,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`});
}

/** The cell root is hidden until terrain, water and physics have been prepared. */
export class WaterSurfaceView {
  constructor(view){this.view=view;}
  stage(cell,packet){
    if(!packet.triangleCount)return null;
    const geometry=new THREE.BufferGeometry(),material=waterMaterial();
    try {
      geometry.setAttribute('position',new THREE.BufferAttribute(packet.positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(packet.normals,3));
      geometry.setAttribute('uv',new THREE.BufferAttribute(packet.uvs,2));
      geometry.setIndex(new THREE.BufferAttribute(packet.indices,1));
      geometry.computeBoundingBox();geometry.computeBoundingSphere();
      const mesh=new THREE.Mesh(geometry,material);mesh.name='water-surface-preview';mesh.visible=false;mesh.renderOrder=3;cell.root.add(mesh);
      for(const resource of [geometry,material]){this.view.own(resource);cell.resources.add(resource);}
      return {cell,packet,mesh,geometry,material,disposed:false};
    }catch(e){geometry.dispose();material.dispose();throw e;}
  }
  compile(h){return h?this.view.renderer.compileAsync(h.mesh,this.view.camera,this.view.scene):Promise.resolve();}
  warm(h){if(h)this.view.warmMesh(h.mesh);}
  commit(h){if(!h)return;if(h.disposed||this.view.findCell(h.cell.packet.id)!==h.cell)throw new Error('HYDRO_STALE_RENDER_CELL');this.remove(h.cell.waterSurface);h.cell.waterSurface=h;h.mesh.visible=true;}
  remove(h){if(!h||h.disposed)return;h.disposed=true;h.mesh.removeFromParent();for(const resource of [h.geometry,h.material]){if(h.cell.resources.has(resource)&&this.view.resources.has(resource))resource.dispose();h.cell.resources.delete(resource);this.view.resources.delete(resource);}if(h.cell.waterSurface===h)h.cell.waterSurface=null;}
}
