/** Bookoo Themis Mini: a small square black scale with a white-on-black display on the front. */
import { Group, MeshBasicMaterial, PlaneGeometry } from 'three';
import { THEMIS } from '../dims';
import type { Mats } from '../materials';
import { cylinder, mesh, roundedBox } from '../parts';
import { scaleDisplay } from '../textures';

export interface ThemisHandle {
  group: Group;
  /** Height of the weighing plate above the scale's own base. */
  topY: number;
  setText(text: string): void;
  dispose(): void;
}

export function buildThemis(m: Mats): ThemisHandle {
  const s = THEMIS.size;
  const h = THEMIS.height;
  const g = new Group();
  // Body and the slightly inset weighing plate.
  g.add(roundedBox(s, h - 3, s, 6, m.blackPlastic, 0, 0, 0));
  g.add(roundedBox(s - 6, 3, s - 6, 2, m.rubber, 0, h - 3, 0));
  // Front display and two touch buttons.
  const disp = scaleDisplay();
  const screenMat = new MeshBasicMaterial({ map: disp.texture, toneMapped: false });
  const screen = mesh(new PlaneGeometry(46, 14), screenMat, 0, h / 2 - 1, s / 2 + 0.25);
  g.add(screen);
  for (const x of [-34, 34]) {
    const b = cylinder(3, 3, 0.6, m.chrome, x, 0, 0, 24);
    b.rotation.x = Math.PI / 2;
    b.position.set(x, h / 2 - 1, s / 2 + 0.3);
    g.add(b);
  }
  return {
    group: g,
    topY: h,
    setText: (t) => disp.draw(t),
    dispose() {
      screenMat.dispose();
      disp.texture.dispose();
    },
  };
}
