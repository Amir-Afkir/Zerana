// Module de gestion LOD et visibilité des chunks/objets (prototype)

export default class LODManager {
  constructor(camera) {
    this.camera = camera;
    this.objects = new Set();
  }

  add(object3D, lodDistances = [50, 150, 300]) {
    // lodDistances : distances seuils pour changer de LOD (à définir selon projet)
    this.objects.add({ object3D, lodDistances, currentLOD: 0 });
  }

  remove(object3D) {
    for (const item of this.objects) {
      if (item.object3D === object3D) {
        this.objects.delete(item);
        break;
      }
    }
  }

  update() {
    const camPos = this.camera.position;

    for (const item of this.objects) {
      const dist = camPos.distanceTo(item.object3D.position);

      let lod = 0;
      for (let i = 0; i < item.lodDistances.length; i++) {
        if (dist > item.lodDistances[i]) {
          lod = i + 1;
        }
      }

      if (lod !== item.currentLOD) {
        item.currentLOD = lod;
        // TODO: changer le modèle/mesh selon lod
        // Pour l'instant on peut juste cacher/montrer à certains seuils
        item.object3D.visible = (lod < item.lodDistances.length);
      }
    }
  }
}