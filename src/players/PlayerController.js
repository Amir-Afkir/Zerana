// src/core/PlayerController.js
import * as THREE from 'three';
import EventBus from '../core/EventBus.js';

export default class PlayerController {
  constructor(player, chunkManager, options = {}) {
    this.player = player;
    this.chunkManager = chunkManager;
    this.velocity = new THREE.Vector3();
    this.walkSpeed = options.walkSpeed || 3;
    this.runSpeed = options.runSpeed || 10;
    this.speed = this.walkSpeed;

    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;

    this.hasPistol = false;
    this.lastTapTime = 0;
    this.doubleTapKey = null;

    this.animations = options.animations || null;
    this.cameraController = options.cameraController || null;

    this.initEventListeners();
  }

  initEventListeners() {
    EventBus.on('keyDown', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = true; break;
        case 'KeyS': this.moveBackward = true; break;
        case 'KeyA': this.moveLeft = true; break;
        case 'KeyD': this.moveRight = true; break;
        case 'Space': this.shoot(); break;
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

    EventBus.on('player:weaponChanged', (hasPistol) => {
      this.hasPistol = hasPistol;
      if (this.cameraController) {
        this.cameraController.isTransitioning = true;
        this.cameraController.transitionTime = 0;
      }
    });
  }

  shoot() {
    if (!this.hasPistol) return;
    if (this.animations?.fireGun) this.animations.fireGun();

    if (this.cameraController) {
      this.cameraController.applyRecoil(0.7, 100);
    } else if (this.camera) {
      const recoil = new THREE.Vector3(0, 0, -0.5);
      this.camera.position.add(recoil);
      setTimeout(() => this.camera.position.sub(recoil), 100);
    }
  }

  update(dt) {
    if (this.moveForward) {
      const now = Date.now();
      if (this.doubleTapKey === 'KeyW' && (now - this.lastTapTime < 300)) {
        this.speed = this.runSpeed;
        if (this.animations?.setRunning) this.animations.setRunning(true);
      }
      this.lastTapTime = now;
      this.doubleTapKey = 'KeyW';
    }
    if (!this.moveForward) {
      this.speed = this.walkSpeed;
      if (this.animations?.setRunning) this.animations.setRunning(false);
    }

    const direction = new THREE.Vector3();
    if (this.moveForward) direction.z -= 1;
    if (this.moveBackward) direction.z += 1;
    if (this.moveLeft) direction.x -= 1;
    if (this.moveRight) direction.x += 1;

    if (direction.length() > 0) {
      direction.normalize();

      const angle = this.player.model.rotation.y;
      const sin = Math.sin(angle), cos = Math.cos(angle);
      const dx = direction.x * cos - direction.z * sin;
      const dz = direction.x * sin + direction.z * cos;

      this.player.model.position.x += dx * this.speed * dt;
      this.player.model.position.z += dz * this.speed * dt;
    }

    if (this.chunkManager?.getHeightAt) {
      this.player.model.position.y = this.chunkManager.getHeightAt(this.player.model.position.x, this.player.model.position.z);
    }

    if (this.animations?.setDirection) {
      this.animations.setDirection(
        this.moveLeft ? -1 : this.moveRight ? 1 : 0,
        this.moveForward ? 1 : this.moveBackward ? -1 : 0
      );
    }
  }
}
