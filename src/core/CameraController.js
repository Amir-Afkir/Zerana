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

    this.moveSpeed = 10;
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

  update(dt, inputManager) {
    if (!this.isPointerLocked) return;

    const velocity = new THREE.Vector3();

    if (inputManager.isKeyPressed('KeyW')) velocity.z -= 1;
    if (inputManager.isKeyPressed('KeyS')) velocity.z += 1;
    if (inputManager.isKeyPressed('KeyA')) velocity.x -= 1;
    if (inputManager.isKeyPressed('KeyD')) velocity.x += 1;

    if (velocity.length() > 0) {
      velocity.normalize();
      velocity.applyEuler(new THREE.Euler(0, this.yawObject.rotation.y, 0));
      velocity.multiplyScalar(this.moveSpeed * dt);

      this.yawObject.position.add(velocity);
    }
  }
}