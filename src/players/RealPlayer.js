// RealPlayer.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { CHUNK_SIZE } from '../utils/constants.js';

export default class RealPlayer {
  constructor(scene, onLoaded, modelUrl = '/models/DefaultAvatarPC.glb', globeManager = null) {
    this.loader = new GLTFLoader();
    this.model = null;
    this.modelUrl = modelUrl;
    this.globeManager = globeManager;

    this.loader.load(modelUrl, (gltf) => {
      this.model = gltf.scene;
      this.setScaleFromChunk(CHUNK_SIZE);
      scene.add(this.model);

      if (onLoaded) onLoaded(this);
    });
  }

  setScaleFromChunk(chunkSize) {
    const scale = chunkSize / 100;
    if (this.model) {
      this.model.scale.setScalar(scale);
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
      this.setScaleFromChunk(CHUNK_SIZE);
      this.model.position.copy(prevPos);

      // 🔁 Recalcule automatiquement la hauteur si globeManager est fourni
      if (globeManager) {
        const y = globeManager.getHeightAt(prevPos.x, prevPos.z);
        if (!isNaN(y)) {
          this.model.position.y = y;
        }
      }

      scene.add(this.model);
      if (onLoaded) onLoaded(this.model);
    });
  }
}