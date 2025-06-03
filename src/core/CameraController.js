// Contrôleur caméra 3e personne (type Fortnite/GTA)
import * as THREE from 'three';

export default class CameraController {
  constructor(camera, domElement, scene) {
    this.camera = camera;
    this.domElement = domElement || document.body;
    this.scene = scene;

    // Cible = joueur (boule rouge)
    this.target = this.scene.getObjectByName('cible');
    if (!this.target) {
      console.error("Aucune cible nommée 'cible' trouvée dans la scène !");
    }

    // Paramètres d'orbite
    this.distance = 10; // Distance caméra-joueur
    this.azimuth = 0;   // Angle horizontal (radians)
    this.elevation = Math.PI / 6; // Angle vertical (radians)
    this.sensitivity = 0.01;
    this.zoomSpeed = 0.5;
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
      this.azimuth -= event.movementX * this.sensitivity;
      this.elevation -= event.movementY * this.sensitivity;
      // Clamp l'élévation pour éviter de passer sous le sol
      this.elevation = Math.max(0.1, Math.min(Math.PI / 2.2, this.elevation));
    });
    // Molette pour zoom
    this.domElement.addEventListener('wheel', (event) => {
      this.distance += event.deltaY * this.zoomSpeed * 0.01;
      this.distance = Math.max(2, Math.min(30, this.distance));
    }, { passive: true });
  }

  getObject() {
    return this.camera;
  }

  update() {
    if (!this.target) {
      this.target = this.scene.getObjectByName('cible');
      if (!this.target) return;
    }
    // Calculer la position de la caméra en coordonnées sphériques autour du joueur
    const x = this.target.position.x + this.distance * Math.sin(this.elevation) * Math.sin(this.azimuth);
    const y = this.target.position.y + this.distance * Math.cos(this.elevation);
    const z = this.target.position.z + this.distance * Math.sin(this.elevation) * Math.cos(this.azimuth);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target.position);
  }
}