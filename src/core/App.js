// src/core/App.js
import * as THREE from 'three';
import GlobeManager from './GlobeManager.js'; 
import MapboxManager from './MapboxManager.js';
import PlayerController from '../players/PlayerController.js';
import HeightmapUtils from '../utils/HeightmapUtils.js';
import CameraController from '../players/CameraController.js';
import RealPlayer from '../players/RealPlayer.js';

export class App {
  constructor() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      10000
    );

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0xaaaaaa);
    document.body.appendChild(this.renderer.domElement);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(100, 200, 100);
    this.scene.add(dirLight);
    this.scene.add(new THREE.AmbientLight(0x404040));

    this.mapboxManager = new MapboxManager();

    this.stubPlayer = { position: new THREE.Vector3(0, 0, 0) };

    this.globeManager = new GlobeManager({
      mapbox: this.mapboxManager,
      scene: this.scene,
      player: this.stubPlayer
    });

    this.realPlayer = null;
    this.realPlayerLoaded = false;

    this.realPlayer = new RealPlayer(this.scene, (instance) => {
      this.realPlayerLoaded = true;
      // Dynamically scale the player based on terrain scale (1 chunk ≈ 100 meters)
      const scale = this.globeManager.chunkSize / 100;
      instance.model.scale.setScalar(scale);
      instance.setPosition(
        this.stubPlayer.position.x,
        this.stubPlayer.position.y,
        this.stubPlayer.position.z
      );
    });

    this.playerController = new PlayerController(
      this.realPlayer,
      this.globeManager,
      {
        walkSpeed: 3,
        runSpeed: 10,
        // cameraController: this.cameraController
      }
    );

    this.camera.position.set(0, 30, 50);
    if (this.realPlayerLoaded) {
      this.camera.lookAt(this.realPlayer.getPosition());
    }

    window.addEventListener('resize', () => this.onWindowResize());

    if (window.savedAddress) {
      this.handleAddress(window.savedAddress);
    }

    this.clock = new THREE.Clock();
    
    // CameraController for orbit logic
    this.cameraController = new CameraController(this.renderer.domElement);
  }

  handleAddress = async (address) => {
    try {
      const coords = await this.mapboxManager.fetchCoords(address);
      if (coords) {
        await this.globeManager.initFromCoords(coords[0], coords[1]);

        const chunkInfo = this.globeManager.getChunkInfo(this.stubPlayer.position);
        const centerChunkPos = new THREE.Vector3(
          chunkInfo.position.x * this.globeManager.chunkSize,
          0,
          chunkInfo.position.z * this.globeManager.chunkSize
        );
        const y = HeightmapUtils.getHeightAt(centerChunkPos, this.globeManager) || 0;
        this.stubPlayer.position.set(centerChunkPos.x, y, centerChunkPos.z);
        if (this.realPlayerLoaded) {
          this.realPlayer.setPosition(
            this.stubPlayer.position.x,
            this.stubPlayer.position.y,
            this.stubPlayer.position.z
          );
        }

        this.camera.position.set(centerChunkPos.x, y + 30, centerChunkPos.z + 50);
        this.camera.lookAt(this.stubPlayer.position);
      }
    } catch (err) {
      console.error('[App] Erreur dans handleAddress:', err);
    }
  };

  init() {
    this.animate();
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate = () => {
    requestAnimationFrame(this.animate);

    const dt = this.clock.getDelta();

    // Force initial player position if needed
    if (this.realPlayerLoaded && !this.initialPlayerPositioned) {
      this.initialPlayerPositioned = true;
      this.realPlayer.setPosition(0, 5, 0);
    }

    this.playerController.update(dt);

    const y = HeightmapUtils.getHeightAt(this.stubPlayer.position, this.globeManager);
    if (!isNaN(y)) this.stubPlayer.position.y = y;


    // Orbit camera logic via CameraController
    if (this.realPlayerLoaded && this.realPlayer.model) {
      this.cameraController.update(this.camera, this.realPlayer.model.position);
    }

    this.globeManager.updateChunks();

    this.renderer.render(this.scene, this.camera);
  };
}

export default App;