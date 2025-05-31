import * as THREE from 'three';
import EventBus from './EventBus.js';
import ChunkManager from './ChunkManager.js';
import InputManager from './InputManager.js';
import PlayerController from './PlayerController.js';
import CameraController from './CameraController.js';
import TileFetcher from './TileFetcher.js';


export class App {
  constructor() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      10000
    );
    this.camera.position.set(0, 100, 200);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(this.renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.position.set(100, 200, 100);
    this.scene.add(light);

    this.chunkManager = new ChunkManager(this.scene);
    this.inputManager = new InputManager();
    this.cameraController = new CameraController(this.camera, this.renderer.domElement);
    this.playerController = new PlayerController(this.camera);

    this.tileFetcher = new TileFetcher('https://tonbackend.com/chunks'); // Mets ici l’URL de ton backend

    window.addEventListener('resize', this.onWindowResize.bind(this));

    // Écoute des chunks chargés
    EventBus.on('chunk:loaded', (chunkData) => {
      console.log('[App] Chunk reçu', chunkData);
      this.chunkManager.loadChunk(chunkData);
    });

    // Écoute des coordonnées reçues après géocodage
    EventBus.on('mapbox:coordsReceived', ({ coords, address }) => {
      console.log('[App] Coordonnées reçues pour', address, coords);
      // Tu peux ici mettre à jour la position du joueur ou autre
      // Exemple :
      // this.playerController.setPositionFromCoords(coords);
    });

    this.clock = new THREE.Clock();
  }

  init() {
    this.animate();
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    requestAnimationFrame(this.animate.bind(this));

    const dt = this.clock.getDelta();

    this.playerController.update(dt);
    this.cameraController.update(dt, this.inputManager);
    this.chunkManager.update(dt);

    this.renderer.render(this.scene, this.camera);
  }
}