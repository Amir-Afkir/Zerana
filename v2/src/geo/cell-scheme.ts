import type { GeodeticPosition } from './geodetic.js';
import type { Radians } from './units.js';

export interface WorldCellId {
  readonly scheme: 'web-mercator';
  readonly level: number;
  readonly x: number;
  readonly y: number;
}
export interface GeodeticBounds {
  readonly westRad: Radians;
  readonly southRad: Radians;
  readonly eastRad: Radians;
  readonly northRad: Radians;
  readonly crossesAntimeridian: boolean;
}
export interface CellLocation {
  readonly id: WorldCellId;
  readonly fractionX: number;
  readonly fractionY: number;
}
export interface WorldCellScheme {
  getCellAt(position: GeodeticPosition, level: number): WorldCellId;
  locate(position: GeodeticPosition, level: number): CellLocation;
  getBounds(id: WorldCellId): GeodeticBounds;
  getCenter(id: WorldCellId): GeodeticPosition;
  getNeighbors(id: WorldCellId): readonly WorldCellId[];
  getParent(id: WorldCellId): WorldCellId | null;
  getChildren(id: WorldCellId): readonly WorldCellId[];
  getStableKey(id: WorldCellId): string;
}
