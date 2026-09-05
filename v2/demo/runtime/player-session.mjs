import * as THREE from 'three';
import './player.css';
import { MetricPlayer, PLAYER } from '../../src/runtime/metric-player.ts';
import { FixedClock } from '../../src/runtime/fixed-clock.ts';
import { TerrainPhysics } from '../../src/physics/terrain-physics.ts';
import { createGeoAnchor } from '../../src/geo/enu.ts';
import { ecefToGeodetic } from '../../src/geo/ecef.ts';
import { ecefToThreeLocal, threeLocalToEcef } from '../../src/geo/three-frame.ts';
import { frameTransform, shouldRebase } from '../../src/geo/floating-origin.ts';

/** Browser input/render adapter. The logical player and collisions live in CPU modules. */
export class PlayerSession {
  constructor(view, rebaseWorld) {
    this.view = view;
    this.rebaseWorld = rebaseWorld;
    this.clock = new FixedClock();
    this.keys = new Set();
    this.active = false;
    this.loading = false;
    this.disposed = false;
    this.events = new AbortController();
    this.rebases = 0;
    this.runtimeError = null;
    this.root = new THREE.Group();
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;
    this.geometry = new THREE.CapsuleGeometry(PLAYER.radiusMeters, PLAYER.heightMeters - 2 * PLAYER.radiusMeters, 6, 16);
    this.material = new THREE.MeshStandardMaterial({ color: 0xffc768, roughness: .7 });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.y = PLAYER.heightMeters / 2;
    this.root.add(this.mesh);
    this.view.scene.add(this.root);
    this.panel = document.createElement('section');
    this.panel.className = 'player-panel';
    this.panel.innerHTML = `<h2>Joueur métrique</h2>
      <div class="player-actions"><button type="button" id="player-toggle" disabled>Marcher</button>
      <button type="button" id="player-respawn" disabled>Réapparaître</button></div>
      <label>Origine flottante<select id="player-threshold"><option value="2048">2 048 m — normal</option><option value="256">256 m — test</option><option value="32">32 m — test rapproché</option></select></label>
      <p class="footnote">ZQSD / WASD ou flèches : marcher · Maj : courir · Espace : sauter · Glisser la souris : regarder · Échap : pause.</p>
      <p id="player-status" role="status">Préparation du terrain…</p><dl id="player-metrics"></dl>`;
    document.getElementById('status').before(this.panel);
    this.$ = id => this.panel.querySelector(`#${id}`);
    this.listen(this.$('player-toggle'), 'click', () => this.active ? this.pause() : this.start());
    this.listen(this.$('player-respawn'), 'click', () => this.respawn());
    this.listen(window, 'keydown', event => {
      if (event.code === 'Escape') { this.pause(); return; }
      if (!this.active || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
      if (['KeyW', 'KeyZ', 'KeyA', 'KeyQ', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space'].includes(event.code)) {
        this.keys.add(event.code); event.preventDefault();
      }
    });
    this.listen(window, 'keyup', event => this.keys.delete(event.code));
    this.listen(window, 'blur', () => this.pause());
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.pause(); });
    this.listen(this.view.renderer.domElement, 'webglcontextlost', () => this.pause());
    const canvas = this.view.renderer.domElement;
    canvas.tabIndex = 0;
    this.listen(canvas, 'pointerdown', event => {
      if (!this.active || event.button !== 0) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId); event.preventDefault();
    });
    this.listen(canvas, 'pointermove', event => {
      if (!this.active || !this.drag || this.drag.id !== event.pointerId) return;
      this.player.look((event.clientX - this.drag.x) * .003, (event.clientY - this.drag.y) * .003);
      this.drag.x = event.clientX; this.drag.y = event.clientY;
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.listen(canvas, type, () => { this.drag = null; });
    this.view.onFrame = dt => this.update(dt);
  }
  listen(target, type, fn) { target.addEventListener(type, fn, { signal: this.events.signal }); }
  setLoading(value) { this.loading = value; if (value) this.pause(); this.buttons(); }
  buttons() {
    this.$('player-toggle').disabled = this.loading || !this.player;
    this.$('player-respawn').disabled = this.loading || !this.player;
    this.$('player-toggle').textContent = this.active ? 'Pause' : 'Marcher';
  }
  install(packets, frame, origin, allowPreview) {
    this.pause(); this.physics?.dispose(); this.player = null; this.physics = null;
    this.root.visible = false; this.origin = origin; this.rebases = 0; this.runtimeError = null;
    this.clock = new FixedClock();
    try {
      this.physics = new TerrainPhysics(packets, frame, { allowPreview });
      this.player = new MetricPlayer(origin, frame, this.physics);
      this.$('player-status').textContent = allowPreview
        ? 'Marche expérimentale sur le terrain affiché. Altitudes absolues non certifiées.'
        : 'Prêt : capsule de 1,80 m, collisions terrain. Marche limitée à la zone chargée.';
    } catch (error) {
      this.physics?.dispose(); this.physics = null;
      this.$('player-status').textContent = `Marche indisponible : ${error.message}`;
    }
    this.buttons(); this.report();
  }
  start() {
    if (!this.player || this.loading || this.disposed) return;
    this.keys.clear(); this.clock.reset(); this.player.freezeInterpolation();
    this.view.controls.enableDamping = false;
    this.view.controls.update(); // Drain pending orbit deltas before handing over the camera.
    this.view.controls.enabled = false;
    this.active = true; this.root.visible = true;
    if (this.view.markerRoot) this.view.markerRoot.children[0].visible = false;
    this.view.camera.near = .1; this.view.camera.far = 5000; this.view.camera.updateProjectionMatrix();
    this.view.renderer.domElement.focus({ preventScroll: true });
    this.buttons(); this.draw(1); this.report();
  }
  pause() {
    if (this.disposed) return;
    if (this.active && this.player && !this.runtimeError) this.draw(1);
    this.active = false; this.keys.clear(); this.drag = null; this.clock.reset();
    this.player?.freezeInterpolation();
    this.view.controls.enabled = true; this.view.controls.enableDamping = true;
    this.buttons(); this.report();
  }
  respawn() {
    if (!this.player || this.loading) return;
    this.pause();
    try {
      this.player = new MetricPlayer(this.origin, this.player.frame, this.physics);
      this.start();
    } catch (error) { this.runtimeError = error.message; this.$('player-status').textContent = error.message; }
  }
  rebase(next) {
    this.player?.rebase(next); this.rebases++;
    if (this.active) this.draw(this.alpha ?? 1);
    else if (this.player && this.root.visible) this.drawBody(this.player.renderPose(1));
    this.report();
  }
  update(dt) {
    if (!this.active || !this.player || this.disposed) return;
    try {
      const has = (...keys) => keys.some(key => this.keys.has(key));
      const input = { forward: Number(has('KeyW', 'KeyZ', 'ArrowUp')) - Number(has('KeyS', 'ArrowDown')),
        right: Number(has('KeyD', 'ArrowRight')) - Number(has('KeyA', 'KeyQ', 'ArrowLeft')),
        sprint: has('ShiftLeft', 'ShiftRight'), jump: has('Space') };
      this.alpha = this.clock.advance(dt, step => this.player.step(step, input));
      const local = ecefToThreeLocal(this.player.state.ecefPosition, this.player.frame);
      if (shouldRebase(local, Number(this.$('player-threshold').value))) {
        this.rebaseWorld(createGeoAnchor(ecefToGeodetic(this.player.state.ecefPosition)));
      }
      this.draw(this.alpha); this.report();
    } catch (error) {
      this.runtimeError = error.message; this.pause();
      this.$('player-status').textContent = `Marche arrêtée : ${error.message}`;
    }
  }
  drawBody(pose) {
    const t = frameTransform(createGeoAnchor(ecefToGeodetic(pose.footEcef)), this.player.frame);
    const r = t.rotation, p = t.translationMeters;
    this.root.matrix.set(r[0], r[1], r[2], p[0], r[3], r[4], r[5], p[1], r[6], r[7], r[8], p[2], 0, 0, 0, 1);
    this.root.matrixWorldNeedsUpdate = true;
  }
  draw(alpha) {
    const pose = this.player.renderPose(alpha); this.drawBody(pose);
    this.view.camera.position.fromArray(pose.eye); this.view.camera.up.fromArray(pose.up);
    this.view.controls.target.fromArray(pose.target); this.view.camera.lookAt(this.view.controls.target);
    this.view.camera.updateMatrixWorld(true); this.lastPose = pose;
  }
  report() {
    if (!this.player) { window.__ZERANA_PLAYER_DEBUG__ = { available: false, active: false }; return; }
    const state = this.player.state;
    this.root.updateMatrixWorld(true);
    // lookAt changes orientation after updating world matrices; diagnostics may run
    // before the next render. Synchronize the camera inverse before projecting.
    this.view.camera.updateMatrixWorld(true);
    const transformScale = new THREE.Vector3().setFromMatrixScale(this.root.matrixWorld);
    const ndc = new THREE.Vector3(...ecefToThreeLocal(state.ecefPosition, this.player.frame)).project(this.view.camera).toArray();
    window.__ZERANA_PLAYER_DEBUG__ = { available: true, active: this.active, runtimeError: this.runtimeError,
      state, steps: this.clock.steps, droppedSeconds: this.clock.droppedSeconds, rebases: this.rebases,
      heightMeters: PLAYER.heightMeters, radiusMeters: PLAYER.radiusMeters, scale: transformScale.toArray(),
      colliderCount: this.physics.colliderCount, triangleCount: this.physics.triangleCount,
      altitudeAuthority: this.physics.altitudeAuthority, footNdc: ndc,
      cameraEcef: threeLocalToEcef(this.view.camera.position.toArray(), this.player.frame), geometryId: this.geometry.uuid };
    const now = performance.now();
    if (now - (this.lastReportTime || 0) < 200) return;
    this.lastReportTime = now;
    const rows = [['Taille', '1,80 m · échelle 1'], ['Simulation', '60 Hz fixe'], ['État', !this.active ? 'En pause' : state.boundaryBlocked ? 'Bord de la zone chargée' : state.grounded ? 'Au sol' : 'En l’air'],
      ['Colliders', this.physics.colliderCount], ['Pas simulés', this.clock.steps], ['Recentrages', this.rebases]];
    this.$('player-metrics').replaceChildren(...rows.flatMap(([name, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = String(value); return [dt, dd];
    }));
  }
  dispose() {
    if (this.disposed) return;
    this.pause(); this.disposed = true; this.events.abort(); this.view.onFrame = null;
    this.physics?.dispose(); this.root.removeFromParent(); this.geometry.dispose(); this.material.dispose();
    this.panel.remove(); window.__ZERANA_PLAYER_DEBUG__ = { disposed: true };
  }
}
