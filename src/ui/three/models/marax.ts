/**
 * Lelit Mara X V1 (≈ 220 × 410 × 350 mm): brushed-steel body on feet, cup-warmer rail, the
 * E61-style group with its cam lever, a 58 mm portafilter with a double spout, twin gauges
 * (pump and boiler), steam and water wands with their knobs, the drip tray with its grate,
 * the three-position temperature switch (0 / I / II) and the lit I/O rocker.
 */
import {
  BoxGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
} from 'three';
import { MARAX } from '../dims';
import type { Mats } from '../materials';
import { contactShadow, cylinder, disc, lathe, mesh, roundedBox } from '../parts';
import { gaugeFace } from '../textures';

export interface MaraxHandle {
  group: Group;
  /** Spout outlets (two streams), machine coordinates. */
  spouts: Vector3[];
  /** Drip tray grate height and the centre under the group (where the scale goes). */
  trayTop: number;
  underGroup: Vector3;
  /** 0 = lever down (off), 1 = lever up (pumping). */
  setLever(f: number): void;
  setGauges(pumpAngle: number, boilerAngle: number): void;
  setTempSwitch(pos: 0 | 1 | 2): void;
  dispose(): void;
}

export function buildMarax(m: Mats): MaraxHandle {
  const g = new Group();
  const { width: W, depth: D, height: H, feetH } = MARAX;
  const front = D / 2;
  const own: { dispose(): void }[] = [];

  g.add(contactShadow(W + 150, D + 120, m.shadow, 0, 20));
  for (const [x, z] of [
    [-W / 2 + 20, -front + 25],
    [W / 2 - 20, -front + 25],
    [-W / 2 + 20, front - 25],
    [W / 2 - 20, front - 25],
  ] as const) {
    g.add(cylinder(11, 13, feetH, m.blackPlastic, x, 0, z, 24));
  }
  // Body: brushed steel shell with a slightly darker top plate (cup warmer).
  g.add(roundedBox(W, H - feetH, D, 5, m.steel, 0, feetH, 0));
  g.add(roundedBox(W - 24, 2, D - 30, 1, m.aluDark, 0, H - 0.5, -5));
  // Cup-warmer rail: chrome rods on posts around the top.
  const railY = H + 14;
  const railMat = m.chrome;
  const rx = W / 2 - 10;
  const rz = D / 2 - 18;
  const rails: [Vector3, Vector3][] = [
    [new Vector3(-rx, railY, -rz), new Vector3(rx, railY, -rz)],
    [new Vector3(-rx, railY, rz), new Vector3(rx, railY, rz)],
    [new Vector3(-rx, railY, -rz), new Vector3(-rx, railY, rz)],
    [new Vector3(rx, railY, -rz), new Vector3(rx, railY, rz)],
  ];
  for (const [a, b] of rails) {
    const len = a.distanceTo(b);
    const rod = mesh(
      new CylinderGeometry(3, 3, len, 16),
      railMat,
      (a.x + b.x) / 2,
      railY,
      (a.z + b.z) / 2,
    );
    if (Math.abs(a.x - b.x) > 1) rod.rotation.z = Math.PI / 2;
    else rod.rotation.x = Math.PI / 2;
    g.add(rod);
  }
  for (const [x, z] of [
    [-rx, -rz],
    [rx, -rz],
    [-rx, rz],
    [rx, rz],
  ] as const) {
    g.add(cylinder(3.5, 4.5, 14, railMat, x, H, z, 16));
  }

  // ---- E61-style group ----
  const gy = MARAX.groupY;
  const gz = front + 46;
  g.add(cylinder(24, 26, 12, m.chrome, 0, gy + 14, front + 10, 40)); // neck flange
  const neck = mesh(new CylinderGeometry(20, 20, 50, 40), m.chrome, 0, gy + 30, front + 22);
  neck.rotation.x = Math.PI / 2;
  g.add(neck);
  // The mushroom body: a chrome lathe from the brew head up to the dome.
  g.add(
    lathe(
      [
        [0.01, 0],
        [40, 0],
        [41, 4],
        [38, 12],
        [33, 16],
        [35, 46],
        [33, 62],
        [26, 74],
        [14, 80],
        [0.01, 82],
      ],
      m.chrome,
      0,
      gy - 12,
      gz,
      72,
    ),
  );
  // Cam lever: pivots on top of the dome; down (off) points forward, up (on) points up.
  const lever = new Group();
  lever.position.set(0, gy + 66, gz);
  const arm = mesh(new BoxGeometry(7, 7, 70), m.chrome, 0, 0, 35);
  lever.add(arm);
  lever.add(mesh(new SphereGeometry(10, 32, 24), m.blackPlastic, 0, 0, 72));
  g.add(lever);

  // ---- Portafilter: basket, ears, handle, double spout ----
  const pf = new Group();
  pf.position.set(0, gy - 12, gz);
  pf.add(
    lathe(
      [
        [0.01, -30],
        [30, -30],
        [36, -26],
        [37.5, -4],
        [41, -2],
        [41, 0],
        [0.01, 0],
      ],
      m.chrome,
      0,
      0,
      0,
      64,
    ),
  );
  const handle = new Group();
  handle.position.set(0, -14, 38);
  handle.rotation.x = 0.16;
  const ferrule = mesh(new CylinderGeometry(9, 10, 22, 32), m.chrome, 0, 0, 11);
  ferrule.rotation.x = Math.PI / 2;
  handle.add(ferrule);
  const grip = mesh(new CylinderGeometry(12, 10.5, 100, 32), m.blackPlastic, 0, 0, 72);
  grip.rotation.x = Math.PI / 2;
  handle.add(grip);
  handle.add(mesh(new SphereGeometry(12, 24, 16), m.blackPlastic, 0, 0, 122));
  pf.add(handle);
  // Spout body and the two outlets.
  pf.add(cylinder(12, 16, 14, m.chrome, 0, -44, 0, 32));
  const spoutTipY = MARAX.spoutY - (gy - 12);
  const spouts: Vector3[] = [];
  for (const sx of [-MARAX.spoutGap / 2, MARAX.spoutGap / 2]) {
    const tube = mesh(
      new CylinderGeometry(3.6, 4.8, -44 - spoutTipY, 20),
      m.chrome,
      sx * 0.7,
      (-44 + spoutTipY) / 2,
      0,
    );
    tube.rotation.z = sx > 0 ? -0.12 : 0.12;
    pf.add(tube);
    spouts.push(new Vector3(sx, MARAX.spoutY, gz));
  }
  g.add(pf);

  // ---- Gauges: pump (0–16 bar) and boiler (0–3 bar) ----
  const gaugeY = H - 52;
  const needles: Group[] = [];
  for (const [i, max, label] of [
    [0, 16, 'PUMP'],
    [1, 3, 'BOILER'],
  ] as const) {
    const x = i === 0 ? -52 : 52;
    const face = gaugeFace(max, label);
    const faceMat = new MeshBasicMaterial({ map: face, toneMapped: false });
    own.push(face, faceMat);
    g.add(disc(25, faceMat, x, gaugeY, front + 4));
    const bezel = mesh(new TorusGeometry(26, 3, 16, 48), m.chrome, x, gaugeY, front + 4);
    g.add(bezel);
    g.add(
      cylinder(28, 28, 4, m.chrome, 0, 0, 0, 48)
        .translateX(x)
        .translateY(gaugeY)
        .translateZ(front + 1)
        .rotateX(Math.PI / 2),
    );
    const needle = new Group();
    needle.position.set(x, gaugeY, front + 5);
    const needleMat = new MeshStandardMaterial({ color: 0xd11f1f, roughness: 0.4 });
    own.push(needleMat);
    needle.add(mesh(new BoxGeometry(1.8, 19, 0.8), needleMat, 0, -8.5, 0));
    needle.add(
      mesh(new CylinderGeometry(2.4, 2.4, 1.6, 16), m.blackPlastic, 0, 0, 0.6).rotateX(Math.PI / 2),
    );
    g.add(needle);
    needles.push(needle);
    const glass = disc(25.5, m.glass, x, gaugeY, front + 6.5);
    g.add(glass);
  }

  // ---- Steam (left) and water (right) knobs and wands ----
  for (const side of [-1, 1] as const) {
    const kx = side * (W / 2 - 26);
    const knobY = H - 12;
    const knob = cylinder(17, 15, 22, m.blackPlastic, kx, knobY, front - 40, 32);
    g.add(knob);
    g.add(cylinder(10, 10, 3, m.chrome, kx, knobY + 22, front - 40, 32));
    const pts =
      side < 0
        ? [
            new Vector3(kx - 4, H - 40, front - 10),
            new Vector3(kx - 14, H - 70, front + 18),
            new Vector3(kx - 24, 190, front + 40),
            new Vector3(kx - 28, 120, front + 46),
          ]
        : [
            new Vector3(kx + 4, H - 40, front - 10),
            new Vector3(kx + 10, H - 70, front + 14),
            new Vector3(kx + 14, 200, front + 26),
          ];
    const wand = mesh(
      new TubeGeometry(new CatmullRomCurve3(pts), 40, side < 0 ? 4.5 : 5.5, 16, false),
      m.chrome,
    );
    g.add(wand);
    const tip = pts[pts.length - 1] ?? new Vector3();
    g.add(mesh(new SphereGeometry(side < 0 ? 5.5 : 6.5, 16, 12), m.chrome, tip.x, tip.y, tip.z));
  }

  // ---- Drip tray with grate (protrudes under the group) ----
  const trayTop = feetH + MARAX.trayH;
  const trayZ = front - 20;
  g.add(roundedBox(W - 14, MARAX.trayH, MARAX.trayDepth + 50, 4, m.steel, 0, feetH, trayZ));
  for (let i = -8; i <= 8; i++) {
    g.add(roundedBox(4, 2, MARAX.trayDepth + 40, 1, m.chrome, i * 11.5, trayTop - 0.5, trayZ));
  }

  // ---- Temperature switch (0 / I / II) lower left, I/O rocker lower right ----
  const sw = new Group();
  sw.position.set(-W / 2 + 34, feetH + MARAX.trayH + 30, front + 1);
  sw.add(roundedBox(22, 14, 3, 1.5, m.blackPlastic, 0, -7, 0));
  const toggle = mesh(new CylinderGeometry(2.2, 2.8, 12, 16), m.chrome, 0, 6, 4);
  sw.add(toggle);
  g.add(sw);
  const rockerMat = new MeshStandardMaterial({
    color: 0xff8a1f,
    emissive: 0xff6a00,
    emissiveIntensity: 0.9,
    roughness: 0.4,
  });
  own.push(rockerMat);
  g.add(roundedBox(16, 22, 6, 2, rockerMat, W / 2 - 34, feetH + MARAX.trayH + 19, front + 1));

  return {
    group: g,
    spouts,
    trayTop,
    underGroup: new Vector3(0, trayTop, gz),
    setLever(f) {
      // Rest: the arm points forward and slightly down (x-rotation +0.2); lifted: straight
      // up (−π/2), which opens the E61 valve and starts the pump.
      lever.rotation.x = 0.2 - f * (Math.PI / 2 + 0.2);
    },
    setGauges(pumpAngle, boilerAngle) {
      const [p, b] = needles;
      if (p) p.rotation.z = pumpAngle;
      if (b) b.rotation.z = boilerAngle;
    },
    setTempSwitch(pos) {
      toggle.rotation.z = (pos - 1) * 0.55;
    },
    dispose() {
      for (const o of own) o.dispose();
    },
  };
}
