// Contrôles caméra (PointerLock, FPS)
import * as THREE from 'three';

export default class CameraController {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement || document.body;

    this.enabled = false;
    this.pitchObject = new THREE.Object3D();
    this.yawObject = new THREE.Object3D();
    this.yawObject.position.y = 10; // Hauteur caméra joueur
    this.yawObject.add(this.pitchObject);
    this.pitchObject.add(camera);

    this.lookSpeed = 0.002;

    this.isPointerLocked = false;

    this.bindEvents();
  }

  bindEvents() {
    this.domElement.addEventListener('click', () => {
      this.domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.domElement;
    });

    this.domElement.addEventListener('mousemove', (event) => {
      if (!this.isPointerLocked) return;

      const movementX = event.movementX || 0;
      const movementY = event.movementY || 0;

      this.yawObject.rotation.y -= movementX * this.lookSpeed;
      this.pitchObject.rotation.x -= movementY * this.lookSpeed;
      this.pitchObject.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitchObject.rotation.x));
    });
  }

  getObject() {
    return this.yawObject;
  }

  update(dt) {
    // Le déplacement est piloté via PlayerController, la caméra ne fait que suivre et pivoter avec la souris.
  }
}