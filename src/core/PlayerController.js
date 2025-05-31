// Contrôle du joueur (déplacement, tir)
import * as THREE from 'three';
import EventBus from './EventBus.js';

export default class PlayerController {
  constructor(camera) {
    this.camera = camera;
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.speed = 10; // unités par seconde

    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;

    this.initEventListeners();
  }

  initEventListeners() {
    EventBus.on('keyDown', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = true; break;
        case 'KeyS': this.moveBackward = true; break;
        case 'KeyA': this.moveLeft = true; break;
        case 'KeyD': this.moveRight = true; break;
      }
    });

    EventBus.on('keyUp', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = false; break;
        case 'KeyS': this.moveBackward = false; break;
        case 'KeyA': this.moveLeft = false; break;
        case 'KeyD': this.moveRight = false; break;
      }
    });
  }

  update(dt) {
    const direction = new THREE.Vector3();

    if (this.moveForward) direction.z -= 1;
    if (this.moveBackward) direction.z += 1;
    if (this.moveLeft) direction.x -= 1;
    if (this.moveRight) direction.x += 1;

    if (direction.length() > 0) {
      direction.normalize();
      // Appliquer la rotation de la caméra sur la direction
      const angle = this.camera.rotation.y;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);

      const dx = direction.x * cos - direction.z * sin;
      const dz = direction.x * sin + direction.z * cos;

      this.position.x += dx * this.speed * dt;
      this.position.z += dz * this.speed * dt;
    }
  }
}