import type { GeoAnchor } from '../geo/enu.js';
import { createGeoAnchor } from '../geo/enu.js';
import type { TerrainCellPacket } from '../generation/terrain/terrain-builder.js';
import { frameTransform, transformPoint, transformDirection } from '../geo/floating-origin.js';
import type { LocalFrameTransform } from '../geo/floating-origin.js';
import { vector } from '../geo/linear.js';
import type { Vec3 } from '../geo/linear.js';
import { add, sub, scale, dot, cross, length, unit, bounds, segmentTriangle, rayTriangle, TriangleIndex } from './geometry.js';
import type { Triangle } from './geometry.js';

export const COLLISION = Object.freeze({skinMeters:.015, toleranceMeters:1e-6, maxSweepIterations:32,
  maxSlides:5, maxTriangles:131072, maxQueryTriangles:4096, maxMotionMeters:100});
export interface Capsule { readonly foot: Vec3; readonly up: Vec3; readonly height: number; readonly radius: number; }
export interface Motion { readonly position: Vec3; readonly normals: readonly Vec3[]; readonly limited: boolean; }
export interface PhysicsWorld {
  move(capsule: Capsule, delta: Vec3): Motion;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): {distance:number;normal:Vec3}|null;
  hasSupport(foot: Vec3, up: Vec3, radius: number): boolean;
  rebase(anchor: GeoAnchor): void;
  dispose(): void;
}
interface Collider {
  readonly anchor: GeoAnchor; readonly index: TriangleIndex; readonly packet: TerrainCellPacket;
  readonly toCell: LocalFrameTransform; readonly fromCell: LocalFrameTransform;
}
function endpoints(c: Capsule): readonly [Vec3,Vec3] {
  vector(...c.foot); vector(...c.up);
  if(!Number.isFinite(c.height)||!Number.isFinite(c.radius)||c.radius<=0||c.height<2*c.radius||c.height>5||Math.abs(length(c.up)-1)>1e-6)
    throw new RangeError('Invalid metric capsule');
  return [add(c.foot,scale(c.up,c.radius)),add(c.foot,scale(c.up,c.height-c.radius))];
}
/** Static triangle colliders copied from a committed terrain snapshot.
 * Positions remain cell-local; rebasing replaces query transforms, never the BVHs.
 * This is kinematic capsule/sphere collision, not a general rigid-body simulator.
 */
export class TerrainPhysics implements PhysicsWorld {
  private colliders: readonly Collider[];
  private count = 0;
  private frame: GeoAnchor;
  private maxCells: number;
  private readonly allowPreview: boolean;
  readonly altitudeAuthority: 'ellipsoidal'|'preview-only';
  constructor(packets: readonly TerrainCellPacket[],anchor: GeoAnchor,options: {allowPreview?:boolean;maxCells?:number}={}){
    this.maxCells=options.maxCells??9;this.allowPreview=options.allowPreview===true;this.frame=anchor;
    if(!Number.isInteger(this.maxCells)||this.maxCells<1||this.maxCells>64) throw new RangeError('Invalid collider capacity');
    if(!packets.length||packets.length>this.maxCells) throw new RangeError('Terrain collider capacity exceeded');
    this.altitudeAuthority=packets.some(p=>p.altitudeAuthority==='preview-only')?'preview-only':'ellipsoidal';
    if(this.altitudeAuthority==='preview-only' && options.allowPreview!==true)
      throw new Error('PREVIEW_COLLISION_REQUIRES_EXPLICIT_OPT_IN');
    for(const p of packets){
      if(!['ellipsoidal','preview-only'].includes(p.altitudeAuthority) ||
        (p.altitudeAuthority==='ellipsoidal' && p.verticalReference!=='ELLIPSOIDAL_WGS84'))
        throw new Error('INVALID_COLLIDER_AUTHORITY');
    }
    this.count=packets.reduce((n,p)=>n+p.indices.length/3,0);
    if(this.count>COLLISION.maxTriangles) throw new RangeError('Collision budget exceeded; reduce subdivisions');
    this.colliders=packets.map(p=>{
      const cell=createGeoAnchor(p.anchor.geodetic);
      return {packet:p,anchor:cell,index:new TriangleIndex(p.positions,p.indices),toCell:frameTransform(anchor,cell),fromCell:frameTransform(cell,anchor)};
    });
  }
  /** Publish an incremental set atomically; unchanged packets retain their BVHs.
   * New-cell construction remains bounded to one N<=32 cell per browser frame.
   * The caller pins support cells before eviction. */
  syncPackets(packets: readonly TerrainCellPacket[]): void {
    if(!packets.length||packets.length>this.maxCells) throw new RangeError('Terrain collider capacity exceeded');
    const key=(p:TerrainCellPacket): string => `${p.id.level}/${p.id.x}/${p.id.y}`;
    if(new Set(packets.map(key)).size!==packets.length) throw new Error('Duplicate collider cell');
    const count=packets.reduce((n,p)=>n+p.indices.length/3,0);
    if(count>COLLISION.maxTriangles) throw new RangeError('Collision budget exceeded');
    const old=new Map(this.colliders.map(c=>[key(c.packet),c]));
    const next=packets.map(p=>{
      if(p.altitudeAuthority!==this.altitudeAuthority ||
        (p.altitudeAuthority==='preview-only'&&!this.allowPreview) ||
        (p.altitudeAuthority==='ellipsoidal'&&p.verticalReference!=='ELLIPSOIDAL_WGS84')) throw new Error('INVALID_COLLIDER_AUTHORITY');
      const previous=old.get(key(p));if(previous?.packet===p)return previous;
      const cell=createGeoAnchor(p.anchor.geodetic);
      return {packet:p,anchor:cell,index:new TriangleIndex(p.positions,p.indices),
        toCell:frameTransform(this.frame,cell),fromCell:frameTransform(cell,this.frame)};
    });
    this.colliders=next;this.count=count;
  }
  setCapacity(capacity: number): void {
    if(!Number.isInteger(capacity)||capacity<this.colliders.length||capacity<1||capacity>64) throw new RangeError('Invalid collider capacity');
    this.maxCells=capacity;
  }
  get triangleCount(): number { return this.count; }
  get colliderCount(): number { return this.colliders.length; }
  rebase(anchor: GeoAnchor): void {
    // Prepare every transform before publishing the new frame in one assignment.
    this.colliders=this.colliders.map(c=>({...c,toCell:frameTransform(anchor,c.anchor),fromCell:frameTransform(c.anchor,anchor)}));
    this.frame=anchor;
  }
  dispose(): void { this.colliders=[];this.count=0; }
  private candidates(points: readonly Vec3[],radius: number): readonly Triangle[]{
    const result: Triangle[]=[];
    for(const c of this.colliders){
      const box=bounds(points.map(p=>transformPoint(p,c.toCell)),radius);
      const triangles=c.index.query(box);
      if(result.length+triangles.length>COLLISION.maxQueryTriangles) throw new RangeError('Collision query budget exceeded');
      for(const t of triangles) result.push({a:transformPoint(t.a,c.fromCell),b:transformPoint(t.b,c.fromCell),c:transformPoint(t.c,c.fromCell)});
    }
    return result;
  }
  private sweep(capsule: Capsule,delta: Vec3): {fraction:number;normal:Vec3|null;limited:boolean}{
    const [start,end]=endpoints(capsule),radius=capsule.radius+COLLISION.skinMeters;
    const triangles=this.candidates([start,end,add(start,delta),add(end,delta)],radius+COLLISION.toleranceMeters);
    let fraction=0;
    for(let iteration=0;iteration<COLLISION.maxSweepIterations;iteration++){
      let advance=1-fraction;
      const offset=scale(delta,fraction);
      for(const t of triangles){
        const contact=segmentTriangle(add(start,offset),add(end,offset),t);
        const closing=-dot(contact.normal,delta);
        // A separating supporting plane cannot be crossed by this straight sweep.
        if(closing<=1e-12) continue;
        const gap=contact.distance-radius;
        if(gap<=COLLISION.toleranceMeters) return {fraction,normal:contact.normal,limited:false};
        advance=Math.min(advance,gap/closing);
      }
      if(advance>=1-fraction) return {fraction:1,normal:null,limited:false};
      // Stay strictly on the conservative side of the supporting plane.
      fraction+=advance*.999;
    }
    return {fraction,normal:null,limited:true}; // Never complete an unproven remainder.
  }
  move(capsule: Capsule,delta: Vec3): Motion {
    endpoints(capsule);vector(...delta);
    if(length(delta)>COLLISION.maxMotionMeters) throw new RangeError('Motion exceeds bounded sweep domain');
    let position=capsule.foot,remaining=delta;
    const normals: Vec3[]=[];
    // Small numerical overlap recovery only. Deeply invalid spawns fail closed.
    for(let i=0;i<8;i++){
      const [a,b]=endpoints({...capsule,foot:position});
      let depth=0,normal: Vec3=[0,1,0];
      for(const t of this.candidates([a,b],capsule.radius+COLLISION.skinMeters)){
        const hit=segmentTriangle(a,b,t),penetration=capsule.radius+COLLISION.skinMeters-hit.distance;
        if(penetration>depth){depth=penetration;normal=hit.normal;}
      }
      if(depth<=COLLISION.toleranceMeters) break;
      if(depth>.25 || i===7) return {position:capsule.foot,normals:[],limited:true};
      position=add(position,scale(normal,depth+COLLISION.toleranceMeters));normals.push(normal);
    }
    for(let slide=0;slide<COLLISION.maxSlides;slide++){
      if(length(remaining)<1e-10) return {position,normals,limited:false};
      const hit=this.sweep({...capsule,foot:position},remaining);
      position=add(position,scale(remaining,hit.fraction));
      if(hit.limited) return {position,normals,limited:true};
      if(!hit.normal) return {position,normals,limited:false};
      normals.push(hit.normal);remaining=scale(remaining,1-hit.fraction);
      remaining=sub(remaining,scale(hit.normal,Math.min(0,dot(remaining,hit.normal))));
    }
    return {position,normals,limited:length(remaining)>1e-8};
  }
  raycast(origin: Vec3,direction: Vec3,maxDistance: number): {distance:number;normal:Vec3}|null {
    vector(...origin);direction=unit(direction);
    if(!Number.isFinite(maxDistance)||maxDistance<=0||maxDistance>512) throw new RangeError('Invalid ray length');
    let nearest=maxDistance,normal: Vec3|null=null;
    for(const c of this.colliders){
      const from=transformPoint(origin,c.toCell),dir=transformDirection(direction,c.toCell);
      for(const t of c.index.query(bounds([from,add(from,scale(dir,maxDistance))],2e-5))){
        const distance=rayTriangle(from,dir,t,2e-5);
        if(distance!==null && distance<=nearest){
          nearest=distance;normal=transformDirection(unit(cross(sub(t.b,t.a),sub(t.c,t.a))),c.fromCell);
        }
      }
    }
    return normal?{distance:nearest,normal}:null;
  }
  hasSupport(foot: Vec3,up: Vec3,radius: number): boolean {
    // Conservative operational guard for the loaded patch. Nine footprint probes;
    // not a proof of arbitrary polygon coverage and not a streaming fallback.
    const right=unit(cross(up,Math.abs(up[0])<.8?[1,0,0]:[0,0,1])),forward=cross(right,up);
    for(let i=-1;i<8;i++){
      const offset=i<0?[0,0,0] as Vec3:add(scale(right,Math.cos(i*Math.PI/4)*(radius+.05)),scale(forward,Math.sin(i*Math.PI/4)*(radius+.05)));
      const hit=this.raycast(add(add(foot,offset),scale(up,1)),scale(up,-1),128);
      if(!hit || dot(hit.normal,up)<=0) return false;
    }
    return true;
  }
}
