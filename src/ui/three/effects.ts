/**
 * Moving parts: the two coffee streams from the spout, the grounds falling from the VS6 chute,
 * and the beans heaped in a dosing cup. Each exposes update(dt, …) and keeps its own buffers.
 */
import {
  CylinderGeometry,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mulberry32 } from '../../core/math/rng';
import { approach, beanCount, streamRadiusMm } from './anim';
import { mesh } from './parts';

export interface Streams {
  meshes: Mesh[];
  /** Set the target flow (g/s); the streams thicken or thin smoothly. */
  update(dtS: number, flowGps: number, from: Vector3[], toY: number, timeS: number): boolean;
  dispose(): void;
}

export function buildStreams(mat: Material): Streams {
  const geo = new CylinderGeometry(1, 0.85, 1, 18, 1, true);
  const meshes = [0, 1].map(() => {
    const m = mesh(geo, mat);
    m.visible = false;
    return m;
  });
  let r = 0;
  return {
    meshes,
    update(dtS, flowGps, from, toY, timeS) {
      const target = streamRadiusMm(flowGps);
      const prev = r;
      r = approach(r, target, dtS, target > r ? 0.25 : 0.6);
      if (r < 0.15) r = target > 0 ? r : 0;
      meshes.forEach((m, i) => {
        const p = from[i];
        if (!p || r <= 0.05) {
          m.visible = false;
          return;
        }
        const len = Math.max(1, p.y - toY);
        // A slight wobble and taper so the stream reads as liquid.
        const wob = 0.12 * Math.sin(timeS * 9 + i * 1.7);
        m.visible = true;
        m.scale.set(r * (1 + wob), len, r * (1 - wob));
        m.position.set(p.x, toY + len / 2, p.z);
      });
      return Math.abs(r - prev) > 1e-3 || r > 0;
    },
    dispose() {
      geo.dispose();
    },
  };
}

export interface Grounds {
  mesh: InstancedMesh;
  /** Spawn at `rateGps` from `from` falling to `toY`; returns true while anything moves. */
  update(dtS: number, rateGps: number, from: Vector3, toY: number): boolean;
  dispose(): void;
}

/** Falling grounds: small dark specks with a little spread, recycled from a fixed pool. */
export function buildGrounds(mat: Material, pool = 420): Grounds {
  const geo = new IcosahedronGeometry(0.9, 0);
  const im = new InstancedMesh(geo, mat, pool);
  im.instanceMatrix.setUsage(DynamicDrawUsage);
  const rng = mulberry32(7);
  const pos = new Float32Array(pool * 3);
  const vel = new Float32Array(pool * 3);
  const alive = new Uint8Array(pool);
  const m = new Matrix4();
  const q = new Quaternion();
  const sc = new Vector3(1, 1, 1);
  const v = new Vector3();
  let carry = 0;
  let next = 0;
  im.count = pool;
  for (let i = 0; i < pool; i++) {
    m.makeScale(0, 0, 0);
    im.setMatrixAt(i, m);
  }
  return {
    mesh: im,
    update(dtS, rateGps, from, toY) {
      // ≈ 120 visible specks per gram per second keeps it dense without thousands of instances.
      carry += rateGps * 120 * dtS;
      while (carry >= 1) {
        carry -= 1;
        const i = next;
        next = (next + 1) % pool;
        alive[i] = 1;
        pos[i * 3] = from.x + (rng() - 0.5) * 6;
        pos[i * 3 + 1] = from.y;
        pos[i * 3 + 2] = from.z + (rng() - 0.5) * 6;
        vel[i * 3] = (rng() - 0.5) * 18;
        vel[i * 3 + 1] = -60 - rng() * 60;
        vel[i * 3 + 2] = (rng() - 0.5) * 18;
      }
      let moving = false;
      for (let i = 0; i < pool; i++) {
        if (!alive[i]) continue;
        moving = true;
        vel[i * 3 + 1] = (vel[i * 3 + 1] ?? 0) - 9810 * 0.25 * dtS; // damped g (mm/s²)
        pos[i * 3] = (pos[i * 3] ?? 0) + (vel[i * 3] ?? 0) * dtS;
        pos[i * 3 + 1] = (pos[i * 3 + 1] ?? 0) + (vel[i * 3 + 1] ?? 0) * dtS;
        pos[i * 3 + 2] = (pos[i * 3 + 2] ?? 0) + (vel[i * 3 + 2] ?? 0) * dtS;
        if ((pos[i * 3 + 1] ?? 0) <= toY) {
          alive[i] = 0;
          m.makeScale(0, 0, 0);
        } else {
          v.set(pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0);
          m.compose(v, q, sc);
        }
        im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true;
      return moving || rateGps > 0;
    },
    dispose() {
      geo.dispose();
      im.dispose();
    },
  };
}

export interface Beans {
  mesh: InstancedMesh;
  /** Show the beans for `grams` heaped in a cup of inner radius `r` whose floor is at y0. */
  set(grams: number): void;
  dispose(): void;
}

/** Coffee beans (flattened ellipsoids) heaped in a dosing cup; a fixed random layout. */
export function buildBeans(mat: Material, innerR: number, floorY: number, cap = 260): Beans {
  const geo = new SphereGeometry(1, 10, 8);
  const im = new InstancedMesh(geo, mat, cap);
  const rng = mulberry32(11);
  const mats: Matrix4[] = [];
  const q = new Quaternion();
  const e = new Vector3();
  for (let i = 0; i < cap; i++) {
    // Layered heap: fill the floor first, then stack; ≈ 30 beans per 5 mm layer.
    const layer = Math.floor(i / 30);
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * (innerR - 4.5) * Math.max(0.35, 1 - layer * 0.05);
    const y = floorY + 3 + layer * 4.2 + rng() * 1.5;
    q.setFromAxisAngle(e.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(), rng() * Math.PI);
    const m = new Matrix4().compose(
      new Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr),
      q,
      new Vector3(4.6, 2.9, 3.4),
    );
    mats.push(m);
  }
  for (let i = 0; i < cap; i++) im.setMatrixAt(i, mats[i] ?? new Matrix4());
  im.count = 0;
  return {
    mesh: im,
    set(grams) {
      im.count = beanCount(grams, cap);
    },
    dispose() {
      geo.dispose();
      im.dispose();
    },
  };
}
