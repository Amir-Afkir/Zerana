// RealPlayer.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

export default class RealPlayer {
  constructor(scene, onLoaded, modelUrl = '/models/DefaultAvatarPC.glb') {
    this.loader = new GLTFLoader();
    this.model = null;
    this.modelUrl = modelUrl;

    this.loader.load(modelUrl, (gltf) => {
      this.model = gltf.scene;
      this.model.scale.set(1, 1, 1); // adapte au besoin
      scene.add(this.model);

      if (onLoaded) onLoaded(this);
    });
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

  replaceModel(modelUrl, scene, onLoaded = null) {
    // Sauvegarde la position actuelle
    const prevPos = this.model?.position.clone();
  
    if (this.model) {
      scene.remove(this.model);
      this.model = null;
    }
  
    this.loader.load(modelUrl, (gltf) => {
      this.model = gltf.scene;
      this.model.scale.set(1, 1, 1);
  
      // Appliquer l'ancienne position
      if (prevPos) {
        this.model.position.copy(prevPos);
      }
  
      scene.add(this.model);
      if (onLoaded) onLoaded(this.model);
    });
  }
}