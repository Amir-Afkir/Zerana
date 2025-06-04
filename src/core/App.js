// src/core/App.js
import * as THREE from 'three';
import EventBus from './EventBus.js';
import GlobeManager from './GlobeManager.js'; 
import MapboxManager from './MapboxManager.js';
import PlayerController from '../players/PlayerController.js';
import HeightmapUtils from '../utils/HeightmapUtils.js';
import CameraController from '../players/CameraController.js';
import RealPlayer from '../players/RealPlayer.js';
import AvatarSelector from './../ui/AvatarSelector.js';


export class App {
  constructor(modelUrl) {
    this.modelUrl = modelUrl;
    this.scene = new THREE.Scene();

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

    this.cameraController = new CameraController(this.renderer.domElement);
    this.camera = this.cameraController.getCamera();

    this.realPlayer = new RealPlayer(this.scene, (player) => {
      this.realPlayerLoaded = true;
      // Dynamically scale the player based on terrain scale (1 chunk ≈ 100 meters)
      player.setScaleFromChunk(this.globeManager.chunkSize);
      player.setPosition(0, 5, 0);
      this.cameraController.snapTo(player.model.position);
      // AvatarSelector and keydown handler now initialized after player loaded
      this.avatarSelector = new AvatarSelector(this.realPlayer, this.scene, this.globeManager);
      window.addEventListener('keydown', (e) => {
        if (e.code === 'KeyC') this.avatarSelector.open();
      });
    }, this.modelUrl, this.globeManager);

    this.playerController = new PlayerController(
      this.realPlayer,
      this.globeManager,
      {
        walkSpeed: 3,
        runSpeed: 10,
        // cameraController: this.cameraController
      }
    );

    window.addEventListener('resize', () => this.onWindowResize());

    this.clock = new THREE.Clock();

    // Listen for reposition event
    EventBus.on('player:reposition', () => {
      if (!window.savedAddress) return;
      this.handleAddress(window.savedAddress);
    });
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
          this.realPlayer.setPosition(centerChunkPos.x, y, centerChunkPos.z);
          this.cameraController.snapTo(this.realPlayer.getPosition());
        }
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

    this.playerController.update(dt);

    const y = HeightmapUtils.getHeightAt(this.stubPlayer.position, this.globeManager);
    if (!isNaN(y)) this.stubPlayer.position.y = y;


    // Orbit camera logic via CameraController
    if (this.realPlayerLoaded && this.realPlayer.model) {
      this.cameraController.update(this.realPlayer.model.position);
    }

    this.globeManager.updateChunks();

    this.renderer.render(this.scene, this.cameraController.getCamera());
  };
}

export default App;