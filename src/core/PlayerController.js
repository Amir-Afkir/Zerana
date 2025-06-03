import * as THREE from 'three';
import EventBus from './EventBus.js';

// Pour la gestion physique ou collision, tu pourras plug un module externe (cannon-es, ammo.js, ou maison).

export default class PlayerController {
  constructor(camera, chunkManager, options = {}) {
    this.camera = camera;
    this.chunkManager = chunkManager; // Pour getHeightAt()
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.speed = options.walkSpeed || 3;
    this.walkSpeed = options.walkSpeed || 3;
    this.runSpeed = options.runSpeed || 10;
    this.hasPistol = false;
    this.lastTapTime = 0;
    this.doubleTapKey = null;
    this.prevPos = this.position.clone();

    // Pour le système d'animation, à brancher selon ton archi (ex: mixers, .play('run'))
    this.animations = options.animations || null;

    // Ajout : référence au contrôleur caméra avancé
    this.cameraController = options.cameraController || null;

    // Event listeners
    this.initEventListeners();
  }

  initEventListeners() {
    EventBus.on('keyDown', (key) => {
      switch (key) {
        case 'KeyW': this.moveForward = true; break;
        case 'KeyS': this.moveBackward = true; break;
        case 'KeyA': this.moveLeft = true; break;
        case 'KeyD': this.moveRight = true; break;
        case 'Space': this.shoot(); break; // exemple tir clavier
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

    // Changement d'arme
    EventBus.on('player:weaponChanged', (hasPistol) => {
      this.hasPistol = hasPistol;
      // Déclenche la transition caméra
      if (this.cameraController) {
        // La logique de transition est gérée côté CameraController via EventBus
        // On peut forcer une update immédiate si besoin
        this.cameraController.isTransitioning = true;
        this.cameraController.transitionTime = 0;
      }
    });
  }

  shoot() {
    if (!this.hasPistol) return;
    // Animation de tir (à plugger selon ton archi)
    if (this.animations?.fireGun) this.animations.fireGun();

    // Effet de recul caméra amélioré
    if (this.cameraController) {
      this.cameraController.applyRecoil(0.7, 100);
    } else if (this.camera) {
      // Fallback simple
      const recoil = new THREE.Vector3(0, 0, -0.5);
      this.camera.position.add(recoil);
      setTimeout(() => this.camera.position.sub(recoil), 100);
    }
    // Particules à plugger ici si besoin
  }

  update(dt) {
    // Gestion du run (double tap W)
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

    // Direction mouvement
    const direction = new THREE.Vector3();
    if (this.moveForward) direction.z -= 1;
    if (this.moveBackward) direction.z += 1;
    if (this.moveLeft) direction.x -= 1;
    if (this.moveRight) direction.x += 1;

    if (direction.length() > 0) {
      direction.normalize();
      // Appliquer la rotation caméra sur la direction
      const angle = this.camera.rotation.y;
      const sin = Math.sin(angle), cos = Math.cos(angle);
      const dx = direction.x * cos - direction.z * sin;
      const dz = direction.x * sin + direction.z * cos;

      this.position.x += dx * this.speed * dt;
      this.position.z += dz * this.speed * dt;
    }

    // Ajuster la hauteur depuis heightmap si disponible
    if (this.chunkManager?.getHeightAt) {
      this.position.y = this.chunkManager.getHeightAt(this.position.x, this.position.z);
    }

    // Met à jour la caméra (mode "collée au joueur")
    if (this.camera) this.camera.position.copy(this.position);

    // Exemples d'animation à plugger
    if (this.animations?.setDirection) {
      this.animations.setDirection(
        this.moveLeft ? -1 : this.moveRight ? 1 : 0,
        this.moveForward ? 1 : this.moveBackward ? -1 : 0
      );
    }

    // Pour debug : log la position
    // console.log('Player pos:', this.position.x, this.position.y, this.position.z);

    // Pour compatibilité, tu peux rajouter :
    // this.prevPos.copy(this.position);
  }
}