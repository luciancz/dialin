/** Small geometry helpers shared by the models (all lengths in mm, y up, +z towards you). */
import {
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  PlaneGeometry,
  Vector2,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function mesh(geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/** Rounded box whose bottom sits at `y0`. */
export function roundedBox(
  w: number,
  h: number,
  d: number,
  r: number,
  mat: Material,
  x: number,
  y0: number,
  z: number,
): Mesh {
  return mesh(
    new RoundedBoxGeometry(w, h, d, 4, Math.min(r, w / 2, h / 2, d / 2)),
    mat,
    x,
    y0 + h / 2,
    z,
  );
}

/** Vertical cylinder whose bottom sits at `y0`. */
export function cylinder(
  rTop: number,
  rBottom: number,
  h: number,
  mat: Material,
  x: number,
  y0: number,
  z: number,
  segments = 48,
): Mesh {
  return mesh(new CylinderGeometry(rTop, rBottom, h, segments), mat, x, y0 + h / 2, z);
}

/** Solid of revolution from (radius, height) pairs, bottom at y0. */
export function lathe(
  profile: [number, number][],
  mat: Material,
  x: number,
  y0: number,
  z: number,
  segments = 64,
): Mesh {
  return mesh(
    new LatheGeometry(
      profile.map(([r, h]) => new Vector2(r, h)),
      segments,
    ),
    mat,
    x,
    y0,
    z,
  );
}

/** A contact shadow under a footprint (radial gradient plane). */
export function contactShadow(w: number, d: number, mat: Material, x = 0, z = 0): Mesh {
  const m = mesh(new PlaneGeometry(w, d), mat, x, 0.3, z);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -1;
  // Not part of the object: the camera framing ignores it.
  m.userData.skipBounds = true;
  return m;
}

/** A flat disc facing +z (gauge faces, displays). */
export function disc(r: number, mat: Material, x: number, y: number, z: number): Mesh {
  return mesh(new CircleGeometry(r, 48), mat, x, y, z);
}

export function group(...children: (Mesh | Group)[]): Group {
  const g = new Group();
  for (const c of children) g.add(c);
  return g;
}
