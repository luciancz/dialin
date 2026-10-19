/**
 * Canvas-drawn textures: the VS6 hopper markings, its LED RPM digits, the Mara X gauge faces
 * and the Themis Mini display. Redrawable ones return a `draw` function that only re-uploads
 * when the text changes.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * One revolution of VS6 markings around the hopper: numbers 0..n−1 with `linesPerNumber`
 * small lines between them. u = 0 is the "0" mark; u runs the same way as CylinderGeometry.
 */
export function hopperMarkings(
  numbersPerRev: number,
  linesPerNumber: number,
  dark: boolean,
): CanvasTexture {
  const W = 2048;
  const H = 128;
  const [c, g] = canvas(W, H);
  if (g) {
    g.fillStyle = dark ? '#1c1c1e' : '#ecebe7';
    g.fillRect(0, 0, W, H);
    const ink = dark ? '#e8e6e1' : '#1d1d1f';
    g.strokeStyle = ink;
    g.fillStyle = ink;
    const total = numbersPerRev * linesPerNumber;
    for (let i = 0; i < total; i++) {
      const x = (i / total) * W;
      const major = i % linesPerNumber === 0;
      g.lineWidth = major ? 4 : 2;
      g.beginPath();
      g.moveTo(x, H - 4);
      g.lineTo(x, H - (major ? 46 : 24));
      g.stroke();
      if (major) {
        g.font = 'bold 44px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(String(i / linesPerNumber), x, 46);
      }
    }
  }
  return tex(c);
}

export interface Display {
  texture: CanvasTexture;
  draw(text: string): void;
}

/** Seven-segment style red LED readout (the VS6 RPM display). */
export function ledDisplay(): Display {
  const [c, g] = canvas(256, 96);
  const t = tex(c);
  let last = '';
  const draw = (text: string) => {
    if (text === last || !g) return;
    last = text;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, 256, 96);
    g.font = 'bold 68px "Courier New", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,40,30,0.18)';
    g.fillText('8888', 128, 52);
    g.fillStyle = '#ff3b2e';
    g.shadowColor = '#ff2a1a';
    g.shadowBlur = 14;
    g.fillText(text, 128, 52);
    g.shadowBlur = 0;
    t.needsUpdate = true;
  };
  draw('1000');
  return { texture: t, draw };
}

/** Themis Mini white-on-black display: grams, and the timer when given. */
export function scaleDisplay(): Display {
  const [c, g] = canvas(256, 80);
  const t = tex(c);
  let last = '';
  const draw = (text: string) => {
    if (text === last || !g) return;
    last = text;
    g.fillStyle = '#060606';
    g.fillRect(0, 0, 256, 80);
    g.font = '600 50px ui-monospace, "Courier New", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f4f4f4';
    g.fillText(text, 128, 44);
    t.needsUpdate = true;
  };
  draw('0.0 g');
  return { texture: t, draw };
}

/** Pressure gauge face (0..max bar over 270°, red zone near the top). */
export function gaugeFace(max: number, label: string): CanvasTexture {
  const S = 256;
  const [c, g] = canvas(S, S);
  if (g) {
    g.fillStyle = '#f7f5f0';
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#1b1b1b';
    g.fillStyle = '#1b1b1b';
    const r = S / 2 - 18;
    for (let v = 0; v <= max; v++) {
      // Canvas angles run clockwise from +x; down is π/2. Same sweep as anim.gaugeAngle.
      const a = 0.75 * Math.PI + (v / max) * 1.5 * Math.PI;
      const major = max > 4 ? v % 2 === 0 : true;
      g.lineWidth = major ? 4 : 2;
      g.beginPath();
      g.moveTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
      g.lineTo(
        S / 2 + Math.cos(a) * (r - (major ? 22 : 12)),
        S / 2 + Math.sin(a) * (r - (major ? 22 : 12)),
      );
      g.stroke();
      if (major) {
        g.font = 'bold 22px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(v), S / 2 + Math.cos(a) * (r - 42), S / 2 + Math.sin(a) * (r - 42));
      }
    }
    g.font = '600 20px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(label, S / 2, S / 2 + 58);
    g.fillText('bar', S / 2, S / 2 + 82);
  }
  return tex(c);
}
