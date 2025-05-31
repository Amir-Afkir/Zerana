// Génération & extrusion des bâtiments
import * as THREE from 'three';
import earcut from 'earcut';

export default class BuildingFactory {
  constructor() {
    this.materialCache = new Map();
  }

  // Obtenir ou créer un matériau de couleur donnée
  getMaterial(colorHex) {
    if (this.materialCache.has(colorHex)) {
      return this.materialCache.get(colorHex);
    }
    const material = new THREE.MeshStandardMaterial({ color: colorHex });
    this.materialCache.set(colorHex, material);
    return material;
  }

  // Crée une géométrie extrudée à partir d’un polygone 2D (anneaux de contours)
  createExtrudedBuilding(polygonRings, height, colorHex = 0x999999) {
    if (!polygonRings || polygonRings.length === 0 || height <= 0) {
      return null;
    }

    // Aplatir les coordonnées pour earcut (x0,y0, x1,y1, ...)
    const vertices = [];
    const holes = [];
    let holeIndex = 0;

    // Premier anneau = contour extérieur
    polygonRings[0].forEach(p => {
      vertices.push(p.x, p.y);
    });

    // Autres anneaux = trous
    for (let i = 1; i < polygonRings.length; i++) {
      holeIndex += polygonRings[i - 1].length;
      holes.push(holeIndex);
      polygonRings[i].forEach(p => {
        vertices.push(p.x, p.y);
      });
    }

    // Triangulation
    const indices = earcut(vertices, holes);

    // Positions 3D pour la base et le sommet (extrusion)
    const basePositions = [];
    const topPositions = [];

    for (let i = 0; i < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i + 1];
      basePositions.push(new THREE.Vector3(x, 0, y));
      topPositions.push(new THREE.Vector3(x, height, y));
    }

    const positions = [];
    const normals = [];
    const uvs = [];
    const finalIndices = [];

    // Construire la géométrie extrudée manuellement

    // 1. Ajouter faces latérales (murs)
    for (let i = 0; i < basePositions.length; i++) {
      const next = (i + 1) % basePositions.length;

      const v0 = basePositions[i];
      const v1 = basePositions[next];
      const v2 = topPositions[i];
      const v3 = topPositions[next];

      // 2 triangles pour chaque mur : (v0,v2,v1) et (v1,v2,v3)

      const baseIndex = positions.length / 3;

      // Ajouter positions
      positions.push(v0.x, v0.y, v0.z);
      positions.push(v2.x, v2.y, v2.z);
      positions.push(v1.x, v1.y, v1.z);
      positions.push(v1.x, v1.y, v1.z);
      positions.push(v2.x, v2.y, v2.z);
      positions.push(v3.x, v3.y, v3.z);

      // Indices
      finalIndices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,
        baseIndex + 3, baseIndex + 4, baseIndex + 5
      );

      // Normales approximatives (calcul simplifié)
      const edge1 = new THREE.Vector3().subVectors(v2, v0);
      const edge2 = new THREE.Vector3().subVectors(v1, v0);
      const normal = new THREE.Vector3().crossVectors(edge2, edge1).normalize();

      for (let j = 0; j < 6; j++) {
        normals.push(normal.x, normal.y, normal.z);
      }

      // UVs basiques (à améliorer)
      uvs.push(0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1);
    }

    // 2. Faces du dessus (toit) via earcut triangulation
    const roofBaseIndex = positions.length / 3;
    topPositions.forEach(v => positions.push(v.x, v.y, v.z));
    indices.forEach(i => finalIndices.push(roofBaseIndex + i));

    // Normales toits vers le haut
    for (let i = 0; i < topPositions.length; i++) {
      normals.push(0, 1, 0);
    }

    // UVs toits basiques
    for (let i = 0; i < topPositions.length; i++) {
      uvs.push(topPositions[i].x, topPositions[i].z);
    }

    // Création BufferGeometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(finalIndices);

    geometry.computeVertexNormals();

    // Mesh
    const material = this.getMaterial(colorHex);
    const mesh = new THREE.Mesh(geometry, material);

    return mesh;
  }
}