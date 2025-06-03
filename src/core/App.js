// src/core/App.js
import * as THREE from 'three';
import GlobeManager from './GlobeManager.js'; 
import MapboxManager from './MapboxManager.js';
import PlayerController from './PlayerController.js';
import HeightmapUtils from '../utils/HeightmapUtils.js';
import CameraController from './CameraController.js';

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

    // Lumières
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(100, 200, 100);
    this.scene.add(dirLight);
    this.scene.add(new THREE.AmbientLight(0x404040));

    // Managers
    this.mapboxManager = new MapboxManager();

    // Stub joueur (position sera mise à jour)
    this.stubPlayer = { position: new THREE.Vector3(0, 0, 0) };

    this.globeManager = new GlobeManager({
      mapbox: this.mapboxManager,
      scene: this.scene,
      player: this.stubPlayer
    });

    // Création boule rouge joueur
    // Taille réelle souhaitée en mètres (exemple 1 mètre)
    const realDiameterMeters = 1;
    const scaleFactor = this.globeManager.chunkSize;
    const diameterUnits = realDiameterMeters / scaleFactor;
    const radiusUnits = diameterUnits / 2;

    const geometry = new THREE.SphereGeometry(radiusUnits, 32, 32);
    const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    this.playerMesh = new THREE.Mesh(geometry, material);
    this.playerMesh.position.set(0, 0, 0);
    this.scene.add(this.playerMesh);

    this.playerMesh.name = 'cible';

    const rayEnd = new THREE.Object3D();
    rayEnd.name = 'RaycastEndPoint';
    rayEnd.position.set(0, 0, 10);
    this.playerMesh.add(rayEnd);
    this.scene.add(rayEnd);

    // Instanciation du contrôleur caméra avancé
    this.cameraController = new CameraController(
      this.camera,
      this.renderer.domElement,
      this.scene
    );

    this.scene.add(this.cameraController.getObject());

    // Passe la référence au PlayerController
    this.playerController = new PlayerController(
      this.camera,
      this.globeManager,
      {
        walkSpeed: 3,
        runSpeed: 10,
        cameraController: this.cameraController
      }
    );

    // Position initiale caméra (derrière et au-dessus)
    this.camera.position.set(0, 30, 50);
    this.camera.lookAt(this.playerMesh.position);

    // Resize
    window.addEventListener('resize', this.onWindowResize.bind(this));

    if (window.savedAddress) {
      this.handleAddress(window.savedAddress);
    }

    this.clock = new THREE.Clock();
  }

  handleAddress = async (address) => {
    try {
      const coords = await this.mapboxManager.fetchCoords(address);
      if (coords) {
        await this.globeManager.initFromCoords(coords[0], coords[1]);

        // Placer joueur au centre chunk et hauteur
        const chunkInfo = this.globeManager.getChunkInfo(this.stubPlayer.position);
        const centerChunkPos = new THREE.Vector3(
          chunkInfo.position.x * this.globeManager.chunkSize,
          0,
          chunkInfo.position.z * this.globeManager.chunkSize
        );
        const y = HeightmapUtils.getHeightAt(centerChunkPos, this.globeManager) || 0;
        this.stubPlayer.position.set(centerChunkPos.x, y, centerChunkPos.z);
        this.playerMesh.position.copy(this.stubPlayer.position);

        // Caméra derrière et au-dessus
        this.camera.position.set(centerChunkPos.x, y + 30, centerChunkPos.z + 50);
        this.camera.lookAt(this.stubPlayer.position);
      }
    } catch (err) {
      console.error('[App] Erreur dans handleAddress:', err);
    }
  };

  lonToX(lon) {
    const tile = this.mapboxManager.latLonToTile(lon, 0, this.mapboxManager.zoom);
    return tile.x * this.mapboxManager.chunkSize;
  }

  latToZ(lat) {
    const tile = this.mapboxManager.latLonToTile(0, lat, this.mapboxManager.zoom);
    return tile.y * this.mapboxManager.chunkSize;
  }

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

    // Met à jour la hauteur sur le terrain
    const y = HeightmapUtils.getHeightAt(this.stubPlayer.position, this.globeManager);
    if (!isNaN(y)) this.stubPlayer.position.y = y;

    // Sync boule rouge avec la position joueur
    this.playerMesh.position.copy(this.stubPlayer.position);

    // Caméra suit le joueur avec un léger lag
    const camOffset = new THREE.Vector3(0, 25, 60);
    const camPos = this.stubPlayer.position.clone().add(camOffset);
    this.camera.position.lerp(camPos, 0.1);
    this.camera.lookAt(this.playerMesh.position);

    // Ajout : update du contrôleur caméra avancé
    this.cameraController.update(dt);

    this.globeManager.updateChunks();

    this.renderer.render(this.scene, this.camera);
  };
}

export default App;