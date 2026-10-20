/**
 * Lelit Mara X V1 (PL62X, ≈ 220 × 410 × 355 mm), after Lelit's V1 manual (Pic 4): a brushed
 * steel box on four feet with a wire cup grate and the tank lid on top. On the front: the
 * chrome E61-style group with its cap, side fins and bayonet collar, the brew lever on the
 * group's right (hangs down at rest, lifts towards you), the owner's Normcore 58 mm
 * all-stainless bottomless portafilter, six-lobed black knobs at the top corners
 * (steam left, hot water right) with their wands, the dual steam/pump gauge, two pilot
 * lights, the lit I/O button and the red LELIT badge. The 0/I/II rocker sits in the drip-tray
 * bay behind the tray with its rod grate.
 */
import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pumpNeedleAngle, steamNeedleAngle } from '../anim';
import { MARAX } from '../dims';
import type { Mats } from '../materials';
import {
  contactShadow,
  cylinder,
  disc,
  extrudeAcross,
  extrudeForward,
  filletShape,
  lathe,
  mesh,
  rodX,
  rodZ,
  roundedBox,
  tube,
} from '../parts';
import { basketHoles, dualGaugeFace, lelitBadge, maraxPanelPrint } from '../textures';

export interface MaraxHandle {
  group: Group;
  /** Where the coffee leaves the portafilter (the bottomless basket's centre), machine coordinates. */
  outlets: Vector3[];
  /** Drip tray grate height and the centre under the group (where the scale goes). */
  trayTop: number;
  underGroup: Vector3;
  /** 0 = lever down (off), 1 = lever up (pumping). */
  setLever(f: number): void;
  /** Needles: pump (brew) pressure and steam-boiler pressure, in bar. */
  setGauges(pumpBar: number, steamBar: number): void;
  setTempSwitch(pos: 0 | 1 | 2): void;
  dispose(): void;
}

/** Parallel rods along x at the given depths, merged into one mesh (a wire grate). */
function rodGrate(
  x0: number,
  x1: number,
  zs: number[],
  y: number,
  r: number,
  mat: MeshStandardMaterial,
): Mesh {
  const parts: BufferGeometry[] = zs.map((z) => {
    const geo = new CylinderGeometry(r, r, x1 - x0, 10);
    geo.rotateZ(Math.PI / 2);
    geo.translate((x0 + x1) / 2, y, z);
    return geo;
  });
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return new Mesh(merged, mat);
}

/** A six-lobed knob outline: round lobes to ≈ 29 mm, soft valleys at ≈ 22.5 mm. */
function flowerShape(): Shape {
  const s = new Shape();
  const n = 144;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 22.5 + 6.5 * ((1 + Math.cos(6 * a)) / 2) ** 0.55;
    if (i === 0) s.moveTo(r * Math.cos(a), r * Math.sin(a));
    else s.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  return s;
}

export function buildMarax(m: Mats): MaraxHandle {
  const g = new Group();
  const { width: W, height: H, shellD: D, feetH, bayTop, bayDepth } = MARAX;
  const F = D / 2;
  const back = -D / 2;
  const gz = F + MARAX.groupOut;
  const own: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    own.push(x);
    return x;
  };

  g.add(contactShadow(W + 150, D + MARAX.trayOut + 120, m.shadow, 0, 30));
  for (const [x, z] of [
    [-W / 2 + 28, back + 30],
    [W / 2 - 28, back + 30],
    [-W / 2 + 28, F - 30],
    [W / 2 - 28, F - 30],
  ] as const) {
    g.add(cylinder(9.5, 9.5, feetH, m.rubber, x, 0, z, 20));
  }

  // ---- Shell: full-height side panels, the box between them, the block behind the bay ----
  const side = 6;
  const inner = W - 2 * side;
  for (const sx of [-1, 1]) {
    g.add(roundedBox(side, H - feetH, D, 2.5, m.steel, sx * (W / 2 - side / 2), feetH, 0));
  }
  g.add(roundedBox(inner, H - bayTop, D, 3, m.steel, 0, bayTop, 0));
  g.add(
    roundedBox(
      inner,
      bayTop - feetH + 6,
      D - bayDepth,
      3,
      m.steel,
      0,
      feetH,
      back + (D - bayDepth) / 2,
    ),
  );
  // The front panel's folded lower edge (the bay's roof).
  g.add(roundedBox(W - 6, 4, 9, 2, m.steel, 0, bayTop - 2, F - 4.5));

  // ---- Top: vent slots, the wire cup grate on rubber domes, the tank lid at the back ----
  const gz0 = -22;
  const gz1 = F - 10;
  for (let row = 0; row < 3; row++) {
    const z = gz1 - 28 - row * 34;
    const off = row % 2 === 0 ? 0 : 16;
    for (let i = -3; i <= 2; i++) {
      g.add(roundedBox(22, 0.6, 3.4, 1.6, m.void, i * 32 + 16 - off + 8, H - 0.2, z));
    }
  }
  const gy = H + 8;
  for (const [x, z] of [
    [-96, gz0 + 6],
    [96, gz0 + 6],
    [-96, gz1 - 6],
    [96, gz1 - 6],
  ] as const) {
    g.add(mesh(new SphereGeometry(4.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.rubber, x, H, z));
  }
  const rodZs: number[] = [];
  for (let z = gz0 + 6; z <= gz1 - 5; z += 6.5) rodZs.push(z);
  g.add(rodGrate(-99, 99, rodZs, gy, 1.3, m.wire));
  // Perimeter wire frame.
  g.add(rodX(2.1, -101, 101, gy - 1.4, gz0, m.wire));
  g.add(rodX(2.1, -101, 101, gy - 1.4, gz1, m.wire));
  for (const x of [-101, 101]) g.add(rodZ(2.1, gz0, gz1, x, gy - 1.4, m.wire, 12));
  // Tank lid: a flat plate with folded edges and an oval finger hole.
  const lidZ0 = back + 4;
  const lidZ1 = gz0 - 7;
  const lidZ = (lidZ0 + lidZ1) / 2;
  g.add(roundedBox(W - 14, 3.2, lidZ1 - lidZ0, 1.5, m.steel, 0, H, lidZ));
  const hole = mesh(new CircleGeometry(1, 40), m.void, 0, H + 3.25, lidZ);
  hole.rotation.x = -Math.PI / 2;
  hole.scale.set(22, 8, 1);
  g.add(hole);

  // ---- Front panel print (icons, arcs, the badge pocket) ----
  const leds: [number, number][] = [
    [-70, 255],
    [-50, 255],
  ];
  const power: [number, number] = [-60, 136];
  const badgeAt: [number, number, number, number] = [-60, 107, 48, 15];
  const printTex = keep(
    maraxPanelPrint({
      width: W,
      y0: bayTop,
      y1: H,
      knobs: [
        [-MARAX.valveX, MARAX.valveY],
        [MARAX.valveX, MARAX.valveY],
      ],
      leds,
      power,
      lever: [74, 248],
      badge: badgeAt,
    }),
  );
  const printMat = keep(
    new MeshBasicMaterial({ map: printTex, transparent: true, depthWrite: false }),
  );
  g.add(mesh(new PlaneGeometry(W - 10, H - bayTop), printMat, 0, (H + bayTop) / 2, F + 0.15));
  printTex.repeat.set((W - 10) / W, 1);
  printTex.offset.set(5 / W, 0);

  // ---- Corner valves, six-lobed knobs and the wands ----
  const knobShape = flowerShape();
  for (const side of [-1, 1] as const) {
    const vx = side * MARAX.valveX;
    const vy = MARAX.valveY;
    g.add(rodZ(11, F, F + 40, vx, vy, m.chrome));
    const nut = rodZ(13.5, F + 6, F + 14, vx, vy, m.chrome, 6);
    g.add(nut);
    g.add(rodZ(8, F + 40, F + 45, vx, vy, m.chrome));
    const k = extrudeForward(knobShape, F + 44, F + 62, m.resin, 2.4);
    k.position.set(vx, vy, 0);
    g.add(k);
    const cap = mesh(new SphereGeometry(9.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m.chrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(vx, vy, F + 62);
    g.add(cap);
    // Swivel under the valve body, then the wand.
    g.add(cylinder(7, 7, 11, m.chrome, vx, vy - 22, F + 30, 24));
    if (side < 0) {
      // Steam: down along the left edge to a teardrop tip above the tray.
      g.add(
        tube(
          [
            new Vector3(vx, vy - 20, F + 30),
            new Vector3(vx - 2, vy - 55, F + 32),
            new Vector3(vx - 6, 190, F + 36),
            new Vector3(vx - 9, 130, F + 38),
            new Vector3(vx - 10, 108, F + 38),
          ],
          5,
          m.chrome,
        ),
      );
      g.add(
        lathe(
          [
            [0.01, -25],
            [3.6, -24],
            [6.3, -20],
            [7.3, -14],
            [7, -8],
            [5.2, 0],
          ],
          m.chrome,
          vx - 10,
          108,
          F + 38,
          32,
        ),
      );
    } else {
      // Hot water: a short S-curve to the right of the lever, ending in a nozzle sleeve.
      g.add(
        tube(
          [
            new Vector3(vx, vy - 20, F + 30),
            new Vector3(vx + 1, vy - 40, F + 38),
            new Vector3(vx + 7, vy - 62, F + 46),
            new Vector3(vx + 9, vy - 88, F + 48),
            new Vector3(vx + 9, vy - 96, F + 48),
          ],
          5,
          m.chrome,
        ),
      );
      g.add(cylinder(7.5, 7.5, 24, m.chrome, vx + 9, vy - 118, F + 48, 28));
      g.add(cylinder(6.6, 7.5, 3, m.chrome, vx + 9, vy - 121, F + 48, 28));
    }
  }

  // ---- E61-style group: collar, bell, chimney, octagonal shoulder, hex cap; side fins ----
  const gy0 = MARAX.gasketY;
  const cr = MARAX.collarR;
  g.add(
    lathe(
      [
        [26, gy0],
        [cr - 1.5, gy0],
        [cr, gy0 + 1.5],
        [cr, gy0 + 24],
        [cr - 2, gy0 + 27],
        [cr - 6, gy0 + 28.5],
        [34, gy0 + 32],
        [26, gy0 + 38],
        [22, gy0 + 45],
        [20.5, gy0 + 54],
        [20.5, 300],
        [21.5, 301],
      ],
      m.chrome,
      0,
      0,
      gz,
      96,
    ),
  );
  g.add(cylinder(25, 25, 14, m.chrome, 0, 301, gz, 8));
  g.add(cylinder(17, 17, 4, m.chrome, 0, 315, gz, 40));
  g.add(cylinder(15, 15, 9, m.chrome, 0, 318, gz, 6));
  g.add(
    lathe(
      [
        [15, 0],
        [13, 2],
        [8, 3.2],
        [0.01, 3.4],
      ],
      m.chrome,
      0,
      327,
      gz,
      6,
    ),
  );
  // Hex-socket plug on the chimney's front.
  g.add(rodZ(5.5, gz + 19.5, gz + 22, 0, 268, m.chrome, 24));
  const sock = mesh(new CircleGeometry(2.6, 6), m.void, 0, 268, gz + 22.05);
  g.add(sock);
  // Side fins running back into the panel, behind the chimney.
  for (const sx of [-1, 1]) {
    const fin = extrudeForward(
      filletShape([
        [sx * 14, 318, 3],
        [sx * 27, 318, 6],
        [sx * 37, 262, 12],
        [sx * 42, gy0 + 32, 6],
        [sx * 14, gy0 + 32, 2],
      ]),
      F - 1,
      gz - 4,
      m.chrome,
      4,
    );
    g.add(fin);
  }

  // ---- Brew lever on the group's right: hex fitting, shaft, pivot boss, arm and knob ----
  const ly = gy0 + 13;
  const hex = mesh(new CylinderGeometry(8.5, 8.5, 10, 6), m.chrome, cr + 5, ly, gz);
  hex.rotation.z = Math.PI / 2;
  g.add(hex);
  g.add(rodX(5.5, cr + 10, cr + 30, ly, gz, m.chrome));
  g.add(rodX(12.5, cr + 28, cr + 50, ly, gz, m.chrome, 32));
  const slot = mesh(new BoxGeometry(0.4, 14, 3), m.void, cr + 50.1, ly, gz);
  g.add(slot);
  const lever = new Group();
  lever.position.set(cr + 39, ly, gz);
  lever.add(cylinder(4.5, 5.2, 50, m.chrome, 0, -56, 0, 20));
  lever.add(
    lathe(
      [
        [0.01, -44],
        [6, -42.5],
        [10, -36],
        [11, -24],
        [10.4, -10],
        [7, -1],
        [5, 0],
      ],
      m.resin,
      0,
      -54,
      0,
      32,
    ),
  );
  g.add(lever);

  // ---- Portafilter: the Normcore 58 mm all-stainless bottomless ("unibody", lay-flat):
  // a 30 mm ring with a flat top lip and the E61 ears, open underneath on the recessed
  // perforated basket; a thin neck plate at the base that steps up into a straight,
  // squarish polished bar, its underside level with the ring's base ----
  const pf = new Group();
  pf.position.set(0, gy0, gz);
  const rr = MARAX.pfRingR;
  const ph = MARAX.pfH;
  const bb = MARAX.basketBottomY - gy0;
  // Profiles run bottom → top on the outside (as every lathe here) so the faces point out.
  pf.add(
    lathe(
      [
        [30.2, bb],
        [30.2, -ph + 0.8],
        [31, -ph],
        [rr - 2.2, -ph],
        [rr - 1.4, -ph + 0.8],
        [rr - 1.4, -6.5],
        [rr, -5.2],
        [rr, -0.8],
        [rr - 0.8, 0],
        [29.5, 0],
      ],
      m.chrome,
      0,
      0,
      0,
      96,
    ),
  );
  // A fine groove under the lip.
  pf.add(mesh(new TorusGeometry(rr - 1.2, 0.5, 8, 96), m.void, 0, -5.8, 0).rotateX(Math.PI / 2));
  const holesTex = keep(basketHoles());
  const holesMat = keep(new MeshStandardMaterial({ map: holesTex, metalness: 1, roughness: 0.35 }));
  const bottom = mesh(new CircleGeometry(30.2, 64), holesMat, 0, bb, 0);
  bottom.rotation.x = Math.PI / 2;
  pf.add(bottom);
  // The ears: tabs at the top of the ring, left and right of the handle.
  for (const sx of [-1, 1]) pf.add(roundedBox(9, 4.2, 17, 1.4, m.chrome, sx * (rr + 2.6), -5.4, 0));
  // Handle in profile (z forward, y up, from the ring's base): the neck plate, the ramp, the bar.
  const base = -ph;
  const neck = extrudeAcross(
    filletShape([
      [rr - 8, base, 0],
      [rr + 38, base, 1.5],
      [rr + 38, base + 7.5, 1.5],
      [rr - 8, base + 7.5, 0],
    ]),
    16,
    m.chrome,
    2,
  );
  pf.add(neck);
  // The ramp from the neck up to the bar, then the bar: a soft rounded square, end cut flat.
  pf.add(
    extrudeAcross(
      filletShape([
        [rr + 26, base, 1],
        [rr + 50, base, 0],
        [rr + 50, base + 20, 0],
        [rr + 44, base + 19.6, 3],
        [rr + 32, base + 7.5, 3],
      ]),
      19,
      m.chrome,
      2,
    ),
  );
  const bar = extrudeForward(
    filletShape([
      [-10.5, 0, 7.5],
      [10.5, 0, 7.5],
      [10.5, 21, 7.5],
      [-10.5, 21, 7.5],
    ]),
    rr + 46,
    rr + 152,
    m.chrome,
    2.2,
  );
  bar.position.y = base;
  pf.add(bar);
  g.add(pf);
  const outlets = [new Vector3(0, MARAX.basketBottomY, gz)];

  // ---- Dual gauge (steam over pump), left of the group ----
  const [gx, gyc] = MARAX.gauge;
  const gr = MARAX.gaugeR;
  g.add(rodZ(gr, F, F + 11, gx, gyc, m.chrome, 64));
  g.add(mesh(new TorusGeometry(gr - 1.8, 2.3, 16, 64), m.chrome, gx, gyc, F + 11));
  const faceTex = keep(dualGaugeFace());
  const faceMat = keep(new MeshBasicMaterial({ map: faceTex, toneMapped: false }));
  g.add(disc(gr - 3.6, faceMat, gx, gyc, F + 11.2));
  const needleMat = keep(new MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }));
  const needles: Group[] = [];
  for (const [dy, len] of [
    [3, 22],
    [-3, 24],
  ] as const) {
    const n = new Group();
    n.position.set(gx, gyc + dy, F + 12);
    n.add(mesh(new BoxGeometry(len, 1.4, 0.5), needleMat, len / 2 - 3, 0, 0));
    n.add(rodZ(2, -0.4, 0.8, 0, 0, needleMat, 16));
    g.add(n);
    needles.push(n);
  }
  g.add(disc(gr - 3, m.glass, gx, gyc, F + 13.6));

  // ---- Pilot lights, the lit I/O button, the red badge ----
  const ledOn = keep(
    new MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff2d6, emissiveIntensity: 1.6 }),
  );
  const ledOff = keep(new MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.3 }));
  leds.forEach(([x, y], i) => {
    g.add(disc(1.9, i === 0 ? ledOn : ledOff, x, y, F + 0.3));
  });
  g.add(rodZ(11, F, F + 3.5, power[0], power[1], m.chrome, 40));
  const ringLit = keep(
    new MeshStandardMaterial({ color: 0xe8f4ff, emissive: 0xd8ecff, emissiveIntensity: 1.4 }),
  );
  g.add(mesh(new RingGeometry(8.3, 9.6, 40), ringLit, power[0], power[1], F + 3.55));
  const btn = lathe(
    [
      [8, 0],
      [7.6, 1],
      [5, 1.6],
      [0.01, 1.8],
    ],
    m.chrome,
    0,
    0,
    0,
    40,
  );
  btn.rotation.x = Math.PI / 2;
  btn.position.set(power[0], power[1], F + 3.5);
  g.add(btn);
  const [bx, by, bw, bh] = badgeAt;
  g.add(roundedBox(bw + 4, bh + 4, 3, 3, m.chrome, bx, by - (bh + 4) / 2, F + 1.5));
  const badgeTex = keep(lelitBadge());
  const badgeMat = keep(new MeshBasicMaterial({ map: badgeTex }));
  g.add(mesh(new PlaneGeometry(bw, bh), badgeMat, bx, by, F + 3.1));

  // ---- Drip tray: a brushed box with a dark inside, rods running left to right ----
  const trayZ0 = F - bayDepth + 2;
  const trayZ1 = F + MARAX.trayOut;
  const tw = W - 14;
  const tz = (trayZ0 + trayZ1) / 2;
  const tdep = trayZ1 - trayZ0;
  const tTop = MARAX.trayTop;
  g.add(roundedBox(tw, tTop - 12 - 3, tdep, 8, m.steel, 0, 9, tz));
  const inside = keep(
    new MeshStandardMaterial({ color: 0x2c2e31, metalness: 0.6, roughness: 0.45 }),
  );
  g.add(roundedBox(tw - 8, 0.6, tdep - 8, 3, inside, 0, tTop - 6.2, tz));
  // Rim walls around the grate.
  g.add(roundedBox(tw, 6, 3, 1.2, m.steel, 0, tTop - 6, trayZ1 - 1.5));
  g.add(roundedBox(tw, 6, 3, 1.2, m.steel, 0, tTop - 6, trayZ0 + 1.5));
  for (const sx of [-1, 1]) {
    g.add(roundedBox(3, 6, tdep, 1.2, m.steel, sx * (tw / 2 - 1.5), tTop - 6, tz));
  }
  const trayRods: number[] = [];
  for (let z = trayZ0 + 8; z <= trayZ1 - 6; z += 8) trayRods.push(z);
  g.add(rodGrate(-tw / 2 + 5, tw / 2 - 5, trayRods, tTop - 1.5, 1.5, m.wire));

  // ---- In the bay: the 0/I/II rocker (left) and the use-mode toggle (right wall) ----
  const bayBack = F - bayDepth;
  g.add(roundedBox(20, 26, 3, 2, m.blackPlastic, -58, 50, bayBack + 1.5));
  const rocker = new Group();
  rocker.position.set(-58, 63, bayBack + 3.5);
  rocker.add(roundedBox(15, 21, 4, 2, m.blackPlastic, 0, -10.5, 0));
  g.add(rocker);
  const toggle = mesh(new CylinderGeometry(1.4, 1.8, 10, 12), m.chrome, W / 2 - 10, 62, F - 30);
  toggle.rotation.z = Math.PI / 2;
  g.add(toggle);

  return {
    group: g,
    outlets,
    trayTop: tTop,
    underGroup: new Vector3(0, tTop, gz),
    setLever(f) {
      // Rest: the arm hangs straight down; lifted, it points at you (about the x axis).
      lever.rotation.x = -f * (Math.PI / 2);
    },
    setGauges(pumpBar, steamBar) {
      const [steam, pump] = needles;
      if (steam) steam.rotation.z = steamNeedleAngle(steamBar);
      if (pump) pump.rotation.z = pumpNeedleAngle(pumpBar);
    },
    setTempSwitch(pos) {
      rocker.rotation.x = (pos - 1) * 0.22;
    },
    dispose() {
      for (const o of own) o.dispose();
    },
  };
}
