/** A glass espresso cup with a coffee column and a crema layer that rise with the weight. */
import { CylinderGeometry, Group, type Mesh } from 'three';
import { cremaFraction, liquidHeightMm } from '../anim';
import { CUP } from '../dims';
import type { Mats } from '../materials';
import { lathe, mesh } from '../parts';

export interface CupHandle {
  group: Group;
  /** Liquid surface height above the cup's base, for the streams to land on. */
  surfaceY(): number;
  setGrams(grams: number): void;
}

export function buildCup(m: Mats): CupHandle {
  const g = new Group();
  const { innerR, outerR, height, baseT } = CUP;
  // Thick-walled glass: outer wall up, rounded rim, inner wall down to the base.
  g.add(
    lathe(
      [
        [0.01, 0],
        [outerR - 2, 0],
        [outerR, 2],
        [outerR, height - 1],
        [outerR - 1, height],
        [innerR + 1, height],
        [innerR, height - 1],
        [innerR, baseT + 1],
        [innerR - 1, baseT],
        [0.01, baseT],
      ],
      m.glass,
      0,
      0,
      0,
      64,
    ),
  );
  const unit = new CylinderGeometry(innerR - 0.4, innerR - 0.4, 1, 48);
  const coffee: Mesh = mesh(unit, m.coffee, 0, baseT, 0);
  const crema: Mesh = mesh(unit, m.crema, 0, baseT, 0);
  coffee.visible = false;
  crema.visible = false;
  g.add(coffee, crema);
  let surface = baseT;
  return {
    group: g,
    surfaceY: () => surface,
    setGrams(grams) {
      const h = liquidHeightMm(grams, innerR, height - baseT - 2);
      const cf = cremaFraction(grams);
      const hc = Math.max(0.6, h * cf);
      const hb = Math.max(0, h - hc);
      coffee.visible = hb > 0.2;
      crema.visible = h > 0.2;
      coffee.scale.y = Math.max(0.01, hb);
      coffee.position.y = baseT + hb / 2;
      crema.scale.y = Math.min(hc, h);
      crema.position.y = baseT + hb + Math.min(hc, h) / 2;
      surface = baseT + h;
    },
  };
}
