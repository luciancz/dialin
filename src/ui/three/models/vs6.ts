/**
 * Varia VS6 (191.6 × 130 × 403.7 mm). Seen from the side it is a C of square-section blocks
 * leaning 13.5° forward on a level base: the base with the cup seat and the RPM knob on its
 * right, the column at the back, the head over the cup. The head's top face carries the
 * stepped index collar, the hopper with the grind scale (it turns to set the grind) and the
 * feed ring with six screws, plus the red LED RPM display in its glass window at the front
 * right corner. The chute tab sits under the "varia" wordmark on the head's front, the white
 * chute tube drops into the magnetic 58 mm dosing cup.
 */
import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
} from 'three';
import type { DialSpec } from '../../../core/types';
import { VS6 } from '../dims';
import type { Mats } from '../materials';
import {
  contactShadow,
  cylinder,
  extrudeAcross,
  filletShape,
  lathe,
  mesh,
  roundedBox,
} from '../parts';
import { debossedText, hopperScale, ledDisplay } from '../textures';

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
  /** Show the dosing cup in its seat (false while it sits on the scale). */
  setCupInBay(on: boolean): void;
  dispose(): void;
}

/**
 * The magnetic dosing cup: body-coloured below, a machined ring band with one groove above,
 * a slimmer lip that fits a 58 mm portafilter, brushed stainless inside; with a grounds fill.
 */
export function buildDosingCup(m: Mats): { group: Group; fill: Mesh; setFill(frac: number): void } {
  const g = new Group();
  const { cupOuterR: ro, cupLipR: rl, cupInnerR: ri, cupH: h, cupFloor: f } = VS6;
  const band = h * 0.55;
  g.add(
    lathe(
      [
        [0.01, 0],
        [ro - 1.2, 0],
        [ro, 1.2],
        [ro, band],
      ],
      m.alu,
      0,
      0,
      0,
    ),
  );
  g.add(
    lathe(
      [
        [ro + 0.2, band],
        [ro + 0.2, band + 13],
        [ro - 0.6, band + 14],
        [ro + 0.2, band + 15],
        [ro + 0.2, h - 8],
        [rl, h - 7.5],
        [rl, h - 0.8],
        [rl - 0.8, h],
        [ri + 0.4, h],
        [ri, h - 0.6],
      ],
      m.ring,
      0,
      0,
      0,
    ),
  );
  g.add(
    lathe(
      [
        [ri, h - 0.6],
        [ri, f + 1],
        [ri - 1, f],
        [0.01, f],
      ],
      m.stainless,
      0,
      0,
      0,
    ),
  );
  const fill = mesh(new CylinderGeometry(ri - 0.5, ri - 0.8, 1, 40), m.grounds, 0, f, 0);
  fill.visible = false;
  g.add(fill);
  const usable = h - f - 12;
  const setFill = (frac: number) => {
    const hh = Math.max(0, Math.min(1, frac)) * usable;
    fill.visible = hh > 0.3;
    fill.scale.y = Math.max(0.01, hh);
    fill.position.y = f + hh / 2;
  };
  return { group: g, fill, setFill };
}

export function buildVs6(m: Mats, spec: DialSpec, dark: boolean): Vs6Handle {
  const g = new Group();
  const own: { dispose(): void }[] = [];
  const W = VS6.bodyW;
  const th = (VS6.leanDeg * Math.PI) / 180;
  const baseTop = VS6.feetH + VS6.baseH;
  const back = -VS6.baseD / 2;
  const front = VS6.baseD / 2;
  // The leaning frame: n across the lean (forward), s along it (up), from the base's top rear edge.
  const L = (n: number, s: number): [number, number] => [
    back + n * Math.cos(th) + s * Math.sin(th),
    baseTop - n * Math.sin(th) + s * Math.cos(th),
  ];
  const { columnD: cd, headD: hd, headTopS: st } = VS6;
  const sb = st - VS6.headH;
  // Where the column's front face meets the base top.
  const footS = (cd * Math.sin(th)) / Math.cos(th);

  g.add(contactShadow(W + 110, VS6.baseD + 100, m.shadow, 0, 0));
  for (const [x, z] of [
    [-W / 2 + 14, back + 14],
    [W / 2 - 14, back + 14],
    [-W / 2 + 14, front - 14],
    [W / 2 - 14, front - 14],
  ] as const) {
    g.add(cylinder(6, 6, VS6.feetH, m.rubber, x, 0, z, 16));
  }

  // ---- Body: one side profile (z, y) extruded across the width ----
  const profile = filletShape([
    [back, VS6.feetH, 2],
    [front, VS6.feetH, 2],
    [front, baseTop, 2.5],
    [L(cd, footS)[0], baseTop, 12],
    [...L(cd, sb), 9],
    [...L(hd, sb), 2.5],
    [...L(hd, st), 2.5],
    [...L(0, st), 2.5],
    [back, baseTop, 6],
  ]);
  g.add(extrudeAcross(profile, W, m.alu, 1.6));

  // Cup seat: a shallow round recess in the base top.
  const cupZ = VS6.cupZ;
  const seatRing = mesh(
    new RingGeometry(VS6.seatR - 1.6, VS6.seatR, 64),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: dark ? 0.5 : 0.14 }),
    0,
    baseTop + 0.15,
    cupZ,
  );
  seatRing.rotation.x = -Math.PI / 2;
  own.push(seatRing.material as MeshBasicMaterial);
  g.add(seatRing);

  // RPM / power knob on the right side of the base (press: on/off, turn: ±100 RPM).
  const knob = lathe(
    [
      [0.01, 0],
      [VS6.knobR, 0],
      [VS6.knobR, VS6.knobOut - 2.5],
      [VS6.knobR - 2, VS6.knobOut],
      [0.01, VS6.knobOut],
    ],
    m.alu,
    0,
    0,
    0,
    48,
  );
  knob.rotation.z = -Math.PI / 2;
  knob.position.set(W / 2 - 0.5, VS6.feetH + VS6.baseH / 2, front - 45);
  g.add(knob);

  // ---- The leaning head: everything on it lives in the lean frame ----
  const lean = new Group();
  lean.position.set(0, baseTop, back);
  lean.rotation.x = th;
  g.add(lean);
  // "varia" pressed into the head's front, lower middle.
  const wordTex = debossedText('varia', dark);
  const wordMat = new MeshBasicMaterial({ map: wordTex, transparent: true, depthWrite: false });
  own.push(wordTex, wordMat);
  lean.add(mesh(new PlaneGeometry(82, 25.6), wordMat, 0, sb + 40, hd + 0.25));
  // Chute tab: the front of the removable chute, under the wordmark and wrapping underneath.
  lean.add(roundedBox(56, 14, 2, 1, m.alu, 0, sb - 0.4, hd + 0.4));
  lean.add(roundedBox(56, 1.2, 26, 0.6, m.alu, 0, sb - 1.1, hd - 12));
  // RPM display: gloss black window on the top face, front right, red 4-digit LEDs.
  const led = ledDisplay();
  const ledMat = new MeshBasicMaterial({ map: led.texture, toneMapped: false });
  own.push(led.texture, ledMat);
  const winX = W / 2 - 5 - 17;
  const winN = hd - 5 - 11;
  lean.add(roundedBox(34, 1, 22, 0.5, m.glossBlack, winX, st - 0.5, winN));
  const ledPlane = mesh(new PlaneGeometry(28, 10.5), ledMat, winX, st + 0.56, winN);
  ledPlane.rotation.x = -Math.PI / 2;
  lean.add(ledPlane);

  // Index collar: two stepped rings, the rear edge nearly flush with the head's back.
  const cN = VS6.collarR + 2.5;
  lean.add(cylinder(VS6.collarR, VS6.collarR, 6.5, m.ring, 0, st, cN, 96));
  lean.add(cylinder(VS6.hopperR + 1.6, VS6.hopperR + 2, 5.5, m.ring, 0, st + 6.5, cN, 96));
  // The index: a small triangle on the lower ring's step at the front.
  const idxMat = new MeshBasicMaterial({ color: dark ? 0xbdbfc2 : 0x4a4c50 });
  own.push(idxMat);
  const idx = mesh(new CircleGeometry(1.8, 3), idxMat, 0, st + 6.55, cN + VS6.collarR - 1.4);
  idx.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
  lean.add(idx);

  // Hopper (turns): the scale band, the feed ring with six screws and the funnel into the burrs.
  const hopper = new Group();
  hopper.position.set(0, st + VS6.collarH, cN);
  lean.add(hopper);
  const scale = hopperScale(spec.numbersPerRev, spec.linesPerNumber, dark);
  const scaleMat = new MeshStandardMaterial({ map: scale.texture, roughness: 0.7, metalness: 0 });
  own.push(scale.texture, scaleMat);
  const band = mesh(
    new CylinderGeometry(VS6.hopperR, VS6.hopperR, VS6.hopperH, 128, 1, true),
    scaleMat,
    0,
    VS6.hopperH / 2,
    0,
  );
  hopper.add(band);
  const fr = VS6.feedR;
  const top = VS6.hopperH + VS6.feedH;
  hopper.add(
    lathe(
      [
        [VS6.hopperR - 0.2, VS6.hopperH - 0.6],
        [fr, VS6.hopperH],
        [fr, top - 1],
        [fr - 1, top],
        [fr - 6.5, top],
        [fr - 7, top - 0.6],
        [fr - 7, top - 4],
      ],
      m.ring,
      0,
      0,
      0,
      96,
    ),
  );
  // The funnel inside the ring is the body colour.
  hopper.add(
    lathe(
      [
        [fr - 7, top - 4],
        [VS6.throatR + 1, VS6.hopperH - 4],
        [VS6.throatR, VS6.hopperH - 6],
        [VS6.throatR, VS6.hopperH - 26],
      ],
      m.alu,
      0,
      0,
      0,
      96,
    ),
  );
  const throat = mesh(new CircleGeometry(VS6.throatR, 48), m.void, 0, VS6.hopperH - 24, 0);
  throat.rotation.x = -Math.PI / 2;
  hopper.add(throat);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    hopper.add(
      cylinder(
        1.5,
        1.5,
        0.5,
        m.aluDark,
        Math.sin(a) * (fr - 3.4),
        top,
        Math.cos(a) * (fr - 3.4),
        12,
      ),
    );
  }

  // ---- Chute tube and the dosing cup in its seat ----
  // The tube enters the head's underside straight above the cup.
  const tubeN = (cupZ - back - sb * Math.sin(th)) / Math.cos(th);
  const tubeTop = L(tubeN, sb)[1] + 2;
  const tubeBottom = baseTop - 2 + VS6.cupH - 8;
  g.add(cylinder(VS6.chuteR, VS6.chuteR, tubeTop - tubeBottom, m.alu, 0, tubeBottom, cupZ, 40));
  g.add(
    mesh(
      new CylinderGeometry(VS6.chuteR - 2.5, VS6.chuteR - 2.5, 0.4, 32),
      m.void,
      0,
      tubeBottom,
      cupZ,
    ),
  );
  const chuteExit = new Vector3(0, tubeBottom, cupZ);
  const cup = buildDosingCup(m);
  const cupY = baseTop - 2;
  cup.group.position.set(0, cupY, cupZ);
  g.add(cup.group);
  let fillFrac = 0;
  return {
    group: g,
    chuteExit,
    cupAt: new Vector3(0, cupY, cupZ),
    fillTopY: () => cupY + VS6.cupFloor + fillFrac * (VS6.cupH - VS6.cupFloor - 12),
    setHopper(angle) {
      hopper.rotation.y = angle;
    },
    setRev(rev) {
      scale.setRev(rev);
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
      for (const o of own) o.dispose();
    },
  };
}
