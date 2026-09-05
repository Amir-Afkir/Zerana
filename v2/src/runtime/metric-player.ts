import { createGeoAnchor } from '../geo/enu.js';
import type { GeoAnchor } from '../geo/enu.js';
import { ecefToGeodetic } from '../geo/ecef.js';
import { ecefPosition } from '../geo/geodetic.js';
import type { EcefPosition } from '../geo/geodetic.js';
import { ecefToThreeLocal, threeLocalToEcef, enuToThree, threeToEnu } from '../geo/three-frame.js';
import { rotate, transpose, vector } from '../geo/linear.js';
import type { Vec3 } from '../geo/linear.js';
import { meters, radians, normalizeLongitude } from '../geo/units.js';
import type { Radians } from '../geo/units.js';
import { add, sub, scale, dot, length } from '../physics/geometry.js';
import type { Capsule, PhysicsWorld } from '../physics/terrain-physics.js';

export const PLAYER = Object.freeze({heightMeters:1.8,radiusMeters:.3,walkMetersPerSecond:4,
  sprintMetersPerSecond:7,gravityMetersPerSecondSquared:9.81,jumpMetersPerSecond:5,
  terminalMetersPerSecond:30,maxSlopeRadians:Math.PI/4,groundSnapMeters:.25,
  cameraDistanceMeters:5.5,cameraTargetHeightMeters:1.35,cameraRadiusMeters:.15});
export interface PlayerGeoState {
  readonly ecefPosition: EcefPosition;
  readonly velocityEcefMetersPerSecond: Vec3;
  readonly headingRad: Radians;
  readonly pitchRad: Radians;
  readonly grounded: boolean;
  readonly boundaryBlocked: boolean;
  readonly collisionLimited: boolean;
}
export interface PlayerInput {readonly forward:number;readonly right:number;readonly sprint:boolean;readonly jump:boolean;}
const IDLE: PlayerInput=Object.freeze({forward:0,right:0,sprint:false,jump:false});
const localVector=(global: Vec3,frame: GeoAnchor): Vec3=>enuToThree(rotate(frame.ecefToEnu,global));
const globalVector=(local: Vec3,frame: GeoAnchor): Vec3=>rotate(transpose(frame.ecefToEnu),threeToEnu(local));
const lerpEcef=(a: EcefPosition,b: EcefPosition,t:number): EcefPosition=>ecefPosition(
  meters(a.xMeters+(b.xMeters-a.xMeters)*t),meters(a.yMeters+(b.yMeters-a.yMeters)*t),meters(a.zMeters+(b.zMeters-a.zMeters)*t));

/** One authoritative ECEF pose. Local collision and rendering poses are derived.
 * Supported world: static terrain snapshot; no streaming, steps, vehicles or rigid bodies.
 */
export class MetricPlayer {
  private current: PlayerGeoState;
  private previous: EcefPosition;
  private jumpHeld=false;
  frame: GeoAnchor;
  readonly physics: PhysicsWorld;
  constructor(origin: EcefPosition,frame: GeoAnchor,physics: PhysicsWorld){
    this.frame=frame;this.physics=physics;
    const base=ecefToThreeLocal(origin,frame),basis=this.basis(origin,0),up=basis.up;
    const floor=physics.raycast(add(base,scale(up,10)),scale(up,-1),128);
    if(!floor || dot(floor.normal,up)<Math.cos(PLAYER.maxSlopeRadians)) throw new Error('SPAWN_REQUIRES_WALKABLE_TERRAIN');
    const floorPoint=add(base,scale(up,10-floor.distance));
    if(!physics.hasSupport(floorPoint,up,PLAYER.radiusMeters)) throw new Error('SPAWN_OUTSIDE_SAFE_PATCH');
    const seated=physics.move(this.capsule(add(floorPoint,scale(up,1)),up),scale(up,-1.5));
    if(seated.limited || !seated.normals.some(n=>dot(n,up)>=Math.cos(PLAYER.maxSlopeRadians))) throw new Error('SPAWN_COLLISION_UNRESOLVED');
    const position=threeLocalToEcef(seated.position,frame);
    this.current=Object.freeze({ecefPosition:position,velocityEcefMetersPerSecond:vector(0,0,0),
      headingRad:radians(0),pitchRad:radians(.35),grounded:true,boundaryBlocked:false,collisionLimited:false});
    this.previous=position;
  }
  get state(): PlayerGeoState {return this.current;}
  freezeInterpolation(): void {this.previous=this.current.ecefPosition;this.jumpHeld=false;}
  private capsule(foot: Vec3,up: Vec3): Capsule {
    return {foot,up,height:PLAYER.heightMeters,radius:PLAYER.radiusMeters};
  }
  private basis(position: EcefPosition,heading:number): {up:Vec3;forward:Vec3;right:Vec3}{
    const r=createGeoAnchor(ecefToGeodetic(position)).ecefToEnu;
    const east: Vec3=[r[0],r[1],r[2]],north: Vec3=[r[3],r[4],r[5]],up: Vec3=[r[6],r[7],r[8]];
    return {up:localVector(up,this.frame),
      forward:localVector(add(scale(north,Math.cos(heading)),scale(east,Math.sin(heading))),this.frame),
      right:localVector(add(scale(east,Math.cos(heading)),scale(north,-Math.sin(heading))),this.frame)};
  }
  look(deltaHeading:number,deltaPitch:number): void {
    if(!Number.isFinite(deltaHeading)||!Number.isFinite(deltaPitch)) throw new RangeError('Invalid look input');
    this.current=Object.freeze({...this.current,headingRad:normalizeLongitude(radians(this.current.headingRad+deltaHeading)),
      pitchRad:radians(Math.max(-.15,Math.min(1.2,this.current.pitchRad+deltaPitch)))});
  }
  step(dt:number,input:PlayerInput=IDLE): void {
    if(!Number.isFinite(dt)||Math.abs(dt-1/60)>1e-12) throw new RangeError('Player requires a fixed 1/60 second step');
    if(!Number.isFinite(input.forward)||!Number.isFinite(input.right)||Math.abs(input.forward)>1||Math.abs(input.right)>1)
      throw new RangeError('Invalid movement input');
    const state=this.current,position=ecefToThreeLocal(state.ecefPosition,this.frame),{up,forward,right}=this.basis(state.ecefPosition,state.headingRad);
    const speed=input.sprint?PLAYER.sprintMetersPerSecond:PLAYER.walkMetersPerSecond;
    const magnitude=Math.max(1,Math.hypot(input.forward,input.right));
    let horizontal=scale(add(scale(forward,input.forward),scale(right,input.right)),speed/magnitude);
    const jump=input.jump&&!this.jumpHeld&&state.grounded;this.jumpHeld=input.jump;
    let vertical=state.grounded?0:dot(localVector(state.velocityEcefMetersPerSecond,this.frame),up);
    if(jump) vertical=PLAYER.jumpMetersPerSecond;
    vertical=Math.max(-PLAYER.terminalMetersPerSecond,vertical-PLAYER.gravityMetersPerSecondSquared*dt);
    let delta=scale(add(horizontal,scale(up,vertical)),dt);
    const boundaryBlocked=!this.physics.hasSupport(add(position,delta),up,PLAYER.radiusMeters);
    if(boundaryBlocked){horizontal=[0,0,0];delta=scale(up,vertical*dt);}
    let result=this.physics.move(this.capsule(position,up),delta);
    // Do not convert forward motion into uphill climbing on a steep surface.
    // Retest vertical motion from the original safe pose, rather than accepting it then snapping back.
    const steep=result.normals.some(n=>dot(n,up)>.01 && dot(n,up)<Math.cos(PLAYER.maxSlopeRadians));
    if(steep && length(horizontal)>0) result=this.physics.move(this.capsule(position,up),scale(up,vertical*dt));
    let grounded=vertical<=0 && result.normals.some(n=>dot(n,up)>=Math.cos(PLAYER.maxSlopeRadians));
    if(state.grounded&&!jump&&!grounded&&vertical<=0&&!result.limited){
      const snapped=this.physics.move(this.capsule(result.position,up),scale(up,-PLAYER.groundSnapMeters));
      if(!snapped.limited && snapped.normals.some(n=>dot(n,up)>=Math.cos(PLAYER.maxSlopeRadians))){result=snapped;grounded=true;}
    }
    const velocity=globalVector(scale(sub(result.position,position),1/dt),this.frame);
    this.previous=state.ecefPosition;
    this.current=Object.freeze({...state,ecefPosition:threeLocalToEcef(result.position,this.frame),
      velocityEcefMetersPerSecond:vector(...velocity),grounded,boundaryBlocked,collisionLimited:result.limited});
  }
  rebase(next:GeoAnchor): void {
    this.physics.rebase(next);this.frame=next;
    // ECEF positions, velocity, heading and interpolation history are deliberately untouched.
  }
  renderPose(alpha:number): {footEcef:EcefPosition;foot:Vec3;up:Vec3;forward:Vec3;eye:Vec3;target:Vec3;eyeEcef:EcefPosition}{
    if(!Number.isFinite(alpha)||alpha<0||alpha>1) throw new RangeError('Invalid interpolation alpha');
    const footEcef=lerpEcef(this.previous,this.current.ecefPosition,alpha),foot=ecefToThreeLocal(footEcef,this.frame);
    const {up,forward}=this.basis(footEcef,this.current.headingRad),pitch=this.current.pitchRad;
    const target=add(foot,scale(up,PLAYER.cameraTargetHeightMeters));
    const offset=add(scale(forward,-PLAYER.cameraDistanceMeters*Math.cos(pitch)),scale(up,PLAYER.cameraDistanceMeters*Math.sin(pitch)));
    const radius=PLAYER.cameraRadiusMeters;
    const camera=this.physics.move({foot:sub(target,scale(up,radius)),up,height:radius*2,radius},offset);
    const eye=add(camera.position,scale(up,radius));
    return {footEcef,foot,up,forward,eye,target,eyeEcef:threeLocalToEcef(eye,this.frame)};
  }
}
