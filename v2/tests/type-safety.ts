import { degrees, radians, meters, geodeticRadians, toRadians } from '../src/geo/index.js';
// @ts-expect-error Degrees are not radians.
geodeticRadians(degrees(2), radians(0), meters(0));
// @ts-expect-error An unbranded number cannot enter a geodetic boundary.
geodeticRadians(2, radians(0), meters(0));
// @ts-expect-error Radians are not degrees.
toRadians(radians(1));
// @ts-expect-error Radians are not metres.
geodeticRadians(radians(2), radians(0), radians(0));
