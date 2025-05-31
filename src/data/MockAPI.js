// Simule un backend REST pour tester la récupération de chunks

export default class MockAPI {
  constructor() {
    this.chunkSize = 100;
  }

  // Simule la récupération d’un chunk JSON avec heightmap et bâtiments simples
  async fetchChunk(x, z) {
    // Génération simple d’une heightmap plate avec petites variations
    const gridSize = 65; // ex: 64x64 + 1
    const heightmap = new Float32Array(gridSize * gridSize);
    for (let i = 0; i < heightmap.length; i++) {
      heightmap[i] = Math.sin(i / 10) * 2; // vaguelette simple
    }

    // Simule 2 bâtiments simples en coordonnées locales
    const buildings = [
      {
        id: "bldg_1",
        geometry: [
          [ {x:10, y:10}, {x:30, y:10}, {x:30, y:30}, {x:10, y:30} ]
        ],
        height: 15,
        minHeight: 0,
        type: "residential",
        extrude: true,
        underground: false,
        layer: 0
      },
      {
        id: "bldg_2",
        geometry: [
          [ {x:40, y:40}, {x:50, y:40}, {x:50, y:50}, {x:40, y:50} ]
        ],
        height: 10,
        minHeight: 0,
        type: "commercial",
        extrude: true,
        underground: false,
        layer: 0
      }
    ];

    // Simule des arbres aux positions locales x,z
    const trees = [
      { id: "tree_1", position: { x: 20, z: 20 } },
      { id: "tree_2", position: { x: 45, z: 45 } },
      { id: "tree_3", position: { x: 60, z: 10 } }
    ];

    return {
      x,
      z,
      chunkSize: this.chunkSize,
      heightmap: Array.from(heightmap),
      buildings,
      trees
    };
  }
}