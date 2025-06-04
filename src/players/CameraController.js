// src/players/CameraController.js
import * as THREE from 'three';
import { CHUNK_SIZE } from '../utils/constants.js';

export default class CameraController {
  
  constructor(domElement) {
    this.domElement = domElement;

    // Angle initial de vue orbitale
    this.azimuth = Math.PI;
    this.elevation = Math.PI / 4;

    // Distance de la caméra (proportionnelle au chunk)
    this.baseDistance = CHUNK_SIZE * 0.04;
    this.distance = this.baseDistance;

    // Décalage de la cible (caméra vise la tête/torse du joueur)
    this.targetOffset = new THREE.Vector3(0, CHUNK_SIZE * 0.017, 0); // ≈ 1.7 m

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      CHUNK_SIZE * .01,     // plus petit plan proche
      CHUNK_SIZE * 10000 // ou 1000 selon l'échelle réelle de ton monde
    );

    // Contrôle souris
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.domElement) return;
      this.azimuth -= e.movementX * 0.002;
      this.elevation -= e.movementY * 0.002;
      this.elevation = Math.max(0.1, Math.min(Math.PI / 2.2, this.elevation));
    });

    // Clique pour activer le pointer lock
    this.domElement.addEventListener('click', () => {
      this.domElement.requestPointerLock();
    });

    // Molette pour zoom (indexé aussi au CHUNK_SIZE)
    this.domElement.addEventListener('wheel', (event) => {
      const zoomDelta = (CHUNK_SIZE * 0.01) * (event.deltaY > 0 ? 1 : -1);
      this.distance = THREE.MathUtils.clamp(this.distance + zoomDelta, CHUNK_SIZE * 0.05, CHUNK_SIZE * 1.5);
    }, { passive: true });
  }

  update(target) {
    const sinAz = Math.sin(this.azimuth);
    const cosAz = Math.cos(this.azimuth);
    const sinEl = Math.sin(this.elevation);
    const cosEl = Math.cos(this.elevation);

    const x = target.x + this.distance * sinEl * sinAz;
    const y = target.y + this.distance * cosEl;
    const z = target.z + this.distance * sinEl * cosAz;

    this.camera.position.set(x, y, z);
    this.camera.lookAt(target.clone().add(this.targetOffset));
  }

  getCamera() {
    return this.camera;
  }

  snapTo(target) {
    this.update(target);
  }

}