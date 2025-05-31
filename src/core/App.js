import * as THREE from 'three';
import EventBus from './../core/EventBus.js';
import ChunkManager from './../core/ChunkManager.js';
import InputManager from './../core/InputManager.js';
import PlayerController from './../core/PlayerController.js';
import CameraController from './../core/CameraController.js';

export class App {
  constructor() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 10000);
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

    window.addEventListener('resize', this.onWindowResize.bind(this));

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