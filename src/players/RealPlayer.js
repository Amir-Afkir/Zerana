// RealPlayer.js
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

export default class RealPlayer {
  constructor(scene, onLoaded) {
    this.loader = new GLTFLoader();
    this.model = null;

    this.loader.load('/models/DefaultAvatarPC.glb', (gltf) => {
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
}