// InstancedMesh arbres
import * as THREE from 'three';

export default class TreeFactory {
  constructor(treeGeometry, treeMaterial, maxInstances = 1000) {
    this.treeGeometry = treeGeometry;   // Géométrie simple d’arbre (ex : cylindre + cône)
    this.treeMaterial = treeMaterial;   // Matériau pour les arbres
    this.maxInstances = maxInstances;

    this.instancedMesh = new THREE.InstancedMesh(
      this.treeGeometry,
      this.treeMaterial,
      this.maxInstances
    );

    this.count = 0;
  }

  // Ajoute un arbre à la position donnée (x,z) avec une hauteur y calculée ailleurs
  addTree(position, scale = 1, rotationY = 0) {
    if (this.count >= this.maxInstances) {
      console.warn('Limite max d’arbres atteinte');
      return;
    }

    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(position.x, position.y, position.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0)),
      new THREE.Vector3(scale, scale, scale)
    );

    this.instancedMesh.setMatrixAt(this.count, matrix);
    this.count++;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  // Retourne le mesh instancié à ajouter à la scène
  getMesh() {
    return this.instancedMesh;
  }

  // Réinitialise le pool d’instances
  reset() {
    this.count = 0;
    this.instancedMesh.count = 0;
    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }
}