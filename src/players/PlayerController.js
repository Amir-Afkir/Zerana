// src/players/PlayerController.js
import * as THREE from 'three';
import eventBus from '../stores/eventBus.js';

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
    eventBus.on('keyDown', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = true; break;
        case 'KeyS': this.moveBackward = true; break;
        case 'KeyA': this.moveLeft = true; break;
        case 'KeyD': this.moveRight = true; break;
        case 'Space': this.shoot(); break;
      }
    });

    eventBus.on('keyUp', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = false; break;
        case 'KeyS': this.moveBackward = false; break;
        case 'KeyA': this.moveLeft = false; break;
        case 'KeyD': this.moveRight = false; break;
      }
    });

    eventBus.on('player:weaponChanged', (hasPistol) => {
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

    if (this.cameraController?.applyRecoil) {
      this.cameraController.applyRecoil(0.7, 100);
    }
  }

  update(dt) {
    if (!this.player?.model) return;
    this.handleMovementInput(dt);
    this.updateHeight();
    this.updateAnimations();
  }

  handleMovementInput(dt) {
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

    if (direction.length() === 0) return;
    direction.normalize();

    const angle = this.player.model.rotation.y;
    const sin = Math.sin(angle), cos = Math.cos(angle);
    const dx = direction.x * cos - direction.z * sin;
    const dz = direction.x * sin + direction.z * cos;

    this.player.model.position.x += dx * this.speed * dt;
    this.player.model.position.z += dz * this.speed * dt;
  }

  updateHeight() {
    if (this.chunkManager?.getHeightAt && this.player?.model) {
      const pos = this.player.model.position;
      const height = this.chunkManager.getHeightAt(pos);
      if (!isNaN(height)) pos.y = height;
    }
  }

  updateAnimations() {
    if (this.animations?.setDirection) {
      this.animations.setDirection(
        this.moveLeft ? -1 : this.moveRight ? 1 : 0,
        this.moveForward ? 1 : this.moveBackward ? -1 : 0
      );
    }
  }
}
