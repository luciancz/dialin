/** Small geometry helpers shared by the models (all lengths in mm, y up, +z towards you). */
import {
  type BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  PlaneGeometry,
  Shape,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

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

/**
 * A closed outline through `pts` ([x, y, fillet radius]); each corner with a radius is
 * rounded by a quadratic curve that starts and ends `r` along the two edges.
 */
export function filletShape(pts: readonly (readonly [number, number, number])[]): Shape {
  const n = pts.length;
  const shape = new Shape();
  const at = (i: number) => pts[((i % n) + n) % n] ?? [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y, r] = at(i);
    const [px, py] = at(i - 1);
    const [nx, ny] = at(i + 1);
    const lin = Math.hypot(x - px, y - py) || 1;
    const lout = Math.hypot(nx - x, ny - y) || 1;
    const d = Math.min(r, lin / 2, lout / 2);
    const a: [number, number] = [x + ((px - x) / lin) * d, y + ((py - y) / lin) * d];
    const b: [number, number] = [x + ((nx - x) / lout) * d, y + ((ny - y) / lout) * d];
    if (i === 0) shape.moveTo(a[0], a[1]);
    else shape.lineTo(a[0], a[1]);
    if (d > 0) shape.quadraticCurveTo(x, y, b[0], b[1]);
  }
  shape.closePath();
  return shape;
}

/**
 * Extrude a side profile drawn in (z, y) across the width along x, centred on x = 0, with
 * small rounded side edges. Normals are smoothed on curves and kept sharp on corners.
 */
export function extrudeAcross(shape: Shape, width: number, mat: Material, edge = 1.5): Mesh {
  const geo = new ExtrudeGeometry(shape, {
    depth: width - 2 * edge,
    bevelEnabled: edge > 0,
    bevelThickness: edge,
    bevelSize: edge,
    bevelOffset: -edge,
    bevelSegments: 4,
    curveSegments: 12,
  });
  // Shape x → world z, shape y → world y, extrusion → world −x; then centre it.
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2 - edge, 0, 0);
  // Smooth the fillets and bevels; the flat sides keep their exact normal.
  return new Mesh(flatEnds(toCreasedNormals(geo, 0.45), 0), mat);
}

/** Extrude a front outline drawn in (x, y) from z0 forward to z1. */
export function extrudeForward(
  shape: Shape,
  z0: number,
  z1: number,
  mat: Material,
  edge = 1,
): Mesh {
  const depth = z1 - z0;
  const geo = new ExtrudeGeometry(shape, {
    depth: Math.max(0.1, depth - 2 * edge),
    bevelEnabled: edge > 0,
    bevelThickness: edge,
    bevelSize: edge,
    bevelOffset: -edge,
    bevelSegments: 4,
    curveSegments: 12,
  });
  geo.translate(0, 0, z0 + edge);
  return new Mesh(flatEnds(toCreasedNormals(geo, 0.45), 2), mat);
}

/**
 * Give the triangles of the flat end faces (normal along `axis`) that exact normal. Creased
 * smoothing merges a flat face with the first bevel step (≈ 11° off), which tilts its corner
 * normals and shows the face's triangulation.
 */
function flatEnds(geo: BufferGeometry, axis: 0 | 1 | 2): BufferGeometry {
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i + 2 < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1).sub(a);
    c.fromBufferAttribute(p, i + 2).sub(a);
    const f = b.cross(c).normalize();
    const v = f.getComponent(axis);
    if (Math.abs(v) < 0.9999) continue;
    for (let j = i; j < i + 3; j++) {
      for (let k = 0; k < 3; k++) n.setComponent(j, k, k === axis ? Math.sign(v) : 0);
    }
  }
  n.needsUpdate = true;
  return geo;
}

/** A round rod along x from x0 to x1, at height y and depth z. */
export function rodX(
  r: number,
  x0: number,
  x1: number,
  y: number,
  z: number,
  mat: Material,
  segments = 16,
): Mesh {
  const m = mesh(new CylinderGeometry(r, r, x1 - x0, segments), mat, (x0 + x1) / 2, y, z);
  m.rotation.z = Math.PI / 2;
  return m;
}

/** A round rod along z from z0 to z1 (r1 at the far end, for tapered parts). */
export function rodZ(
  r: number,
  z0: number,
  z1: number,
  x: number,
  y: number,
  mat: Material,
  segments = 24,
  r1 = r,
): Mesh {
  const m = mesh(new CylinderGeometry(r1, r, z1 - z0, segments), mat, x, y, (z0 + z1) / 2);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** A bent tube through `pts` (wands, wires). */
export function tube(pts: Vector3[], r: number, mat: Material, segments = 48): Mesh {
  return new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), segments, r, 16, false), mat);
}
