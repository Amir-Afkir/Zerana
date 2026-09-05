// RealPlayer.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
export default class RealPlayer {
  constructor(scene, onLoaded, modelUrl = '/models/DefaultAvatarPC.glb', globeManager = null, cameraController = null, latitude = null, zoom = 17, chunkSize = null) {
    this.loader = new GLTFLoader();
    this.model = null;
    this.modelUrl = modelUrl;
    this.globeManager = globeManager;
    this.cameraController = cameraController;
    this.currentLatitude = latitude;
    this.zoom = zoom;
    this.chunkSize = chunkSize;
    this.baseHeight = null;

    this.loader.load(modelUrl, (gltf) => {
      this.model = gltf.scene;
      // Suppression de l'appel anticipé à setScaleFromChunk ici : l'échelle sera appliquée plus tard quand la latitude sera connue.
      scene.add(this.model);

      // Cache a reference height so scaling stays stable across calls.
      const box = new THREE.Box3().setFromObject(this.model);
      const size = new THREE.Vector3();
      box.getSize(size);
      this.baseHeight = size.y || 1;

      if (onLoaded) onLoaded(this);
    });
  }

  setScaleFromChunk(chunkSize, latitude, zoom = 17, cameraController = null) {
    if (typeof latitude !== 'number' || isNaN(latitude)) {
      if (this.model) {
        console.warn('[Zerana] Latitude invalide, échelle ignorée');
      }
      return;
    }

    this.currentLatitude = latitude;
    this.zoom = zoom;
    this.cameraController = cameraController;

    const earthCircum = 40075017;
    const tileSizeMeters = (earthCircum * Math.cos(latitude * Math.PI / 180)) / Math.pow(2, zoom);
    const unitsPerMeter = chunkSize / tileSizeMeters;

    // Target a ~human scale, regardless of the GLB unit system.
    const desiredHeightMeters = 1.75;
    const targetHeightUnits = desiredHeightMeters * unitsPerMeter;
    const baseHeight = this.baseHeight || 1;
    const scale = targetHeightUnits / baseHeight;

    if (this.model) this.model.scale.setScalar(scale);

    if (cameraController?.adjustCameraDistance) {
      cameraController.adjustCameraDistance(scale);
    }
  }

  setPosition(x, y, z) {
    if (this.model) this.model.position.set(x, y, z);
  }

  getPosition() {
    return this.model?.position || new THREE.Vector3();
  }

  update(delta) {
    // Pour les animations, à brancher ici
  }

  replaceModel(modelUrl, scene, onLoaded = null, globeManager = null) {
    const prevPos = this.model?.position.clone() || new THREE.Vector3();

    if (this.model) {
      scene.remove(this.model);
      this.model = null;
    }

    this.loader.load(modelUrl, (gltf) => {
      this.model = gltf.scene;
      if (typeof this.currentLatitude === 'number' && !isNaN(this.currentLatitude)) {
        const size = this.chunkSize || 1;
        this.setScaleFromChunk(size, this.currentLatitude, this.zoom, this.cameraController);
      }
      this.model.position.copy(prevPos);

      if (globeManager) {
        const y = globeManager.getHeightAt(prevPos);
        if (!isNaN(y)) {
          this.model.position.y = y;
        }
      }

      scene.add(this.model);
      if (onLoaded) onLoaded(this.model);
    });
  }
}
