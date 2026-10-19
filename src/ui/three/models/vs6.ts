/**
 * Varia VS6 (191.6 × 130 × 403.7 mm): base plate, a column with a cup bay under its overhang,
 * the burr head with the hopper on top. The hopper carries the real markings (numbers 0–9,
 * ten lines each) and turns to the dial position; a small window shows the revolution. The
 * LED readout and the multifunction button are on the overhang's front, the chute exits from
 * its underside into the 58 mm magnetic dosing cup on the base.
 */
import {
  CylinderGeometry,
  Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import type { DialSpec } from '../../../core/types';
import { VS6 } from '../dims';
import type { Mats } from '../materials';
import { contactShadow, cylinder, lathe, mesh, roundedBox } from '../parts';
import { type Display, hopperMarkings, ledDisplay, scaleDisplay } from '../textures';

export interface Vs6Handle {
  group: Group;
  /** Chute exit (grounds start falling here), in the grinder's own coordinates. */
  chuteExit: Vector3;
  /** Top of the ground coffee in the dosing cup (for falling grounds to land). */
  fillTopY(): number;
  /** Dosing cup centre on the base (x, z) and its inner radius. */
  cupAt: Vector3;
  setHopper(angle: number): void;
  setRev(rev: number): void;
  setRpm(rpm: number): void;
  /** 0..1 of the cup's grounds capacity shown. */
  setFill(frac: number): void;
  /** Show the dosing cup in its bay (false while it sits on the scale). */
  setCupInBay(on: boolean): void;
  dispose(): void;
}

/** The 58 mm dosing cup with a grounds fill (shared by the bay and the scale views). */
export function buildDosingCup(m: Mats): { group: Group; fill: Mesh; setFill(frac: number): void } {
  const g = new Group();
  const { cupInnerR: ri, cupOuterR: ro, cupH: h } = VS6;
  g.add(
    lathe(
      [
        [0.01, 0],
        [ro - 1.5, 0],
        [ro, 1.5],
        [ro, h - 1],
        [ro - 0.8, h],
        [ri + 0.6, h],
        [ri, h - 1],
        [ri, 3],
        [0.01, 3],
      ],
      m.aluDark,
      0,
      0,
      0,
      64,
    ),
  );
  const fill = mesh(new CylinderGeometry(ri - 0.5, ri - 0.8, 1, 40), m.grounds, 0, 3, 0);
  fill.visible = false;
  g.add(fill);
  const setFill = (frac: number) => {
    const f = Math.max(0, Math.min(1, frac));
    const hh = f * (h - 12);
    fill.visible = hh > 0.3;
    fill.scale.y = Math.max(0.01, hh);
    fill.position.y = 3 + hh / 2;
  };
  return { group: g, fill, setFill };
}

export function buildVs6(m: Mats, spec: DialSpec, dark: boolean): Vs6Handle {
  const g = new Group();
  const { depth, width, height, baseH, columnDepth, headR, headH, hopperR, hopperH } = VS6;
  const back = -depth / 2;
  const colZ = back + columnDepth / 2;
  const headBottom = height - hopperH - headH;
  const bayTop = VS6.chuteY - 10;
  const lowerDepth = 60;

  g.add(contactShadow(width + 120, depth + 110, m.shadow, 0, 0));
  // Rubber feet and the base plate.
  for (const [x, z] of [
    [-48, back + 18],
    [48, back + 18],
    [-48, -back - 18],
    [48, -back - 18],
  ] as const) {
    g.add(cylinder(7, 7, 3, m.rubber, x, 0, z, 20));
  }
  g.add(roundedBox(width, baseH - 3, depth, 7, m.alu, 0, 3, 0));
  // Column: shallow below the cup bay, full depth above it (the overhang).
  g.add(
    roundedBox(
      width,
      bayTop - baseH + 10,
      lowerDepth,
      14,
      m.alu,
      0,
      baseH - 5,
      back + lowerDepth / 2,
    ),
  );
  g.add(roundedBox(width, headBottom - bayTop + 6, columnDepth, 18, m.alu, 0, bayTop, colZ));
  // Burr head and the hopper ring on top.
  g.add(cylinder(headR, headR, headH, m.alu, 0, headBottom, colZ, 72));
  const ringTex = hopperMarkings(spec.numbersPerRev, spec.linesPerNumber, dark);
  const ringMat = new MeshStandardMaterial({ map: ringTex, roughness: 0.6, metalness: 0.05 });
  const hopper = new Group();
  hopper.position.set(0, headBottom + headH, colZ);
  const ring = mesh(
    new CylinderGeometry(hopperR, hopperR, hopperH, 96, 1, true),
    ringMat,
    0,
    hopperH / 2,
    0,
  );
  hopper.add(ring);
  hopper.add(cylinder(hopperR, hopperR, 2, m.alu, 0, hopperH - 2, 0, 72));
  // Lid with a shallow dome and a knob.
  hopper.add(
    lathe(
      [
        [0.01, 0],
        [hopperR - 2, 0],
        [hopperR - 4, 5],
        [hopperR - 14, 9],
        [0.01, 10],
      ],
      m.alu,
      0,
      hopperH,
      0,
      72,
    ),
  );
  g.add(hopper);
  // Index mark at the front of the head, just under the ring.
  const index = mesh(
    new PlaneGeometry(4, 12),
    new MeshBasicMaterial({ color: dark ? 0xff5a3c : 0xd2401f }),
    0,
    headBottom + headH - 8,
    colZ + headR + 0.3,
  );
  g.add(index);
  // Revolution counter window.
  const revDisp: Display = scaleDisplay();
  const revMat = new MeshBasicMaterial({ map: revDisp.texture, toneMapped: false });
  g.add(mesh(new PlaneGeometry(22, 8), revMat, 0, headBottom + 18, colZ + headR + 0.3));
  // LED RPM readout and the multifunction button on the overhang front.
  const front = colZ + columnDepth / 2;
  const led = ledDisplay();
  const ledMat = new MeshBasicMaterial({ map: led.texture, toneMapped: false });
  g.add(mesh(new PlaneGeometry(52, 19), ledMat, 0, bayTop + 92, front + 0.4));
  const btn = cylinder(7.5, 7.5, 3, m.aluDark, 0, 0, 0, 32);
  btn.rotation.x = Math.PI / 2;
  btn.position.set(0, bayTop + 62, front + 1);
  g.add(btn);
  // Chute nozzle under the overhang (removable dosing tube).
  const cupZ = back + lowerDepth + VS6.cupOuterR + 6;
  g.add(cylinder(11, 13, 16, m.aluDark, 0, bayTop - 16, cupZ, 32));
  g.add(cylinder(14, 14, 3, m.alu, 0, bayTop - 3, cupZ, 32));
  const chuteExit = new Vector3(0, bayTop - 16, cupZ);
  // Dosing cup in the bay.
  const cup = buildDosingCup(m);
  cup.group.position.set(0, baseH, cupZ);
  g.add(cup.group);
  let fillFrac = 0;
  return {
    group: g,
    chuteExit,
    cupAt: new Vector3(0, baseH, cupZ),
    fillTopY: () => baseH + 3 + fillFrac * (VS6.cupH - 12),
    setHopper(angle) {
      hopper.rotation.y = angle;
    },
    setRev(rev) {
      revDisp.draw(`rev ${rev}`);
    },
    setRpm(rpm) {
      led.draw(String(Math.round(rpm)).padStart(4, '0'));
    },
    setFill(frac) {
      fillFrac = Math.max(0, Math.min(1, frac));
      cup.setFill(fillFrac);
    },
    setCupInBay(on) {
      cup.group.visible = on;
    },
    dispose() {
      ringTex.dispose();
      ringMat.dispose();
      revDisp.texture.dispose();
      revMat.dispose();
      led.texture.dispose();
      ledMat.dispose();
      (index.material as MeshBasicMaterial).dispose();
    },
  };
}
