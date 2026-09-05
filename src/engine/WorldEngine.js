import * as THREE from 'three';
import { CHUNK_SIZE, GRID_SIZE, ZOOM_LEVEL, MAPBOX_API_KEY } from '../utils/constants.js';
import MapboxService from '../services/MapboxService.js';
import OverpassService from '../services/OverpassService.js';
import TerrainBuilder from '../render/TerrainBuilder.js';
import BuildingRenderer from '../render/BuildingRenderer.js';
import TreeRenderer from '../render/TreeRenderer.js';
import ChunkSystem from './systems/ChunkSystem.js';
import InputManager from './InputManager.js';
import CameraController from '../players/CameraController.js';
import PlayerController from '../players/PlayerController.js';
import RealPlayer from '../players/RealPlayer.js';
import { getQualitySettings } from './Quality.js';

export default class WorldEngine {
  constructor({
    container,
    apiKey = MAPBOX_API_KEY,
    zoom = ZOOM_LEVEL,
    chunkSize = CHUNK_SIZE,
    gridSize = GRID_SIZE,
    modelUrl = '/models/DefaultAvatarPC.glb'
  } = {}) {
    this.container = container;
    this.apiKey = apiKey;
    this.zoom = zoom;
    this.chunkSize = chunkSize;
    this.gridSize = gridSize;
    this.modelUrl = modelUrl;

    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.quality = getQualitySettings();

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x111318);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    if (this.container) this.container.appendChild(this.renderer.domElement);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(100, 200, 100);
    this.scene.add(dirLight);
    this.scene.add(new THREE.AmbientLight(0x404040));

    this.mapbox = new MapboxService({
      apiKey: this.apiKey,
      zoom: this.zoom,
      chunkSize: this.chunkSize,
      cacheSize: this.quality.mapboxCacheSize
    });

    this.overpass = new OverpassService({
      chunkSize: this.chunkSize
    });

    this.terrainBuilder = new TerrainBuilder({ chunkSize: this.chunkSize });
    const debugBuildings = import.meta.env.DEV &&
      typeof window !== 'undefined' &&
      Boolean(window.__ZERANA_BUILDING_DEBUG__);
    this.buildingRenderer = new BuildingRenderer({
      chunkSize: this.chunkSize,
      maxBuildings: this.quality.maxBuildings,
      debug: debugBuildings
    });
    this.treeRenderer = new TreeRenderer({ chunkSize: this.chunkSize, maxTrees: this.quality.maxTrees });

    this.playerProxy = { position: new THREE.Vector3(0, 0, 0) };

    this.chunkSystem = new ChunkSystem({
      mapbox: this.mapbox,
      overpass: this.overpass,
      scene: this.scene,
      player: this.playerProxy,
      gridSize: this.gridSize,
      chunkSize: this.chunkSize,
      terrainBuilder: this.terrainBuilder,
      buildingRenderer: this.buildingRenderer,
      treeRenderer: this.treeRenderer,
      maxConcurrentTerrain: this.quality.maxConcurrentTerrain,
      maxConcurrentDetails: this.quality.maxConcurrentDetails,
      buildingsRadius: this.quality.buildingsRadius,
      treesRadius: this.quality.treesRadius,
      overpassRadius: this.quality.overpassRadius,
      disposeOnHide: this.quality.disposeOnHide
    });

    this.inputManager = new InputManager(window);
    this.cameraController = new CameraController(this.renderer.domElement, this.chunkSize);

    this.realPlayer = null;
    this.realPlayerLoaded = false;
    this.playerController = null;
    this.lastLatitude = null;

    this.geocodeController = null;
    this.animationFrame = null;
    this.onVisibilityChange = null;
  }

  init() {
    this.inputManager.connect();
    this.setupPlayer();
    window.addEventListener('resize', this.onWindowResize);
    this.onVisibilityChange = () => {
      if (document.hidden) {
        if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
        return;
      }
      if (!this.animationFrame) this.animate();
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.animate();
  }

  setupPlayer() {
    this.realPlayer = new RealPlayer(this.scene, (player) => {
      this.realPlayerLoaded = true;
      // Scale will be applied once a valid latitude is known.
      player.setPosition(0, 5, 0);
      this.cameraController.snapTo(player.model.position);

      if (typeof this.lastLatitude === 'number' && !Number.isNaN(this.lastLatitude)) {
        this.realPlayer.setScaleFromChunk(this.chunkSize, this.lastLatitude, this.zoom, this.cameraController);
      }

      this.playerController = new PlayerController(player, this.chunkSystem, {
        walkSpeed: 3,
        runSpeed: 10,
        cameraController: this.cameraController
      });
    }, this.modelUrl, this.chunkSystem, this.cameraController, null, this.zoom, this.chunkSize);
  }

  setAddress = async (address) => {
    if (!address || !this.mapbox) return false;
    if (this.geocodeController) this.geocodeController.abort();
    this.geocodeController = new AbortController();

    try {
      const coords = await this.mapbox.fetchCoords(address, this.geocodeController.signal);
      if (!coords) return false;
      this.lastLatitude = coords[1];

      this.chunkSystem.reset();
      await this.chunkSystem.initFromCoords(coords[0], coords[1]);

      this.playerProxy.position.set(0, 0, 0);
      const chunkInfo = this.chunkSystem.getChunkInfo(this.playerProxy.position);
      const centerChunkPos = new THREE.Vector3(
        chunkInfo.position.x * this.chunkSize,
        0,
        chunkInfo.position.z * this.chunkSize
      );

      const y = this.chunkSystem.getHeightAt(centerChunkPos);
      this.playerProxy.position.set(centerChunkPos.x, isNaN(y) ? 0 : y, centerChunkPos.z);

      if (this.realPlayerLoaded && this.realPlayer?.model) {
        const latitude = coords[1];
        this.realPlayer.setScaleFromChunk(this.chunkSize, latitude, this.zoom, this.cameraController);
        this.realPlayer.setPosition(centerChunkPos.x, isNaN(y) ? 0 : y, centerChunkPos.z);
        this.cameraController.snapTo(this.realPlayer.getPosition());
      }

      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      return false;
    }
  };

  onWindowResize = () => {
    this.cameraController.getCamera().aspect = window.innerWidth / window.innerHeight;
    this.cameraController.getCamera().updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  animate = () => {
    this.animationFrame = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();

    if (this.playerController) this.playerController.update(dt);
    if (this.realPlayerLoaded && this.realPlayer?.model) {
      this.playerProxy.position.copy(this.realPlayer.model.position);
      this.cameraController.update(this.realPlayer.model.position);
    }

    this.chunkSystem.updateChunks();
    this.renderer.render(this.scene, this.cameraController.getCamera());
  };

  dispose() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.onWindowResize);
    if (this.onVisibilityChange) document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.inputManager.dispose();
    this.chunkSystem.dispose();
    this.mapbox.dispose();
    this.buildingRenderer.dispose();
    this.treeRenderer.dispose();
    this.renderer.dispose();
    if (this.container && this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
