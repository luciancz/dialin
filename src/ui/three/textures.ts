/**
 * Canvas-drawn textures: the VS6 hopper scale, wordmark and LED RPM digits, the Mara X gauge
 * face, panel print and badge, and the Themis Mini display. Redrawable ones return a `draw` function that only re-uploads
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

export interface Display {
  texture: CanvasTexture;
  draw(text: string): void;
}

export interface HopperScale {
  texture: CanvasTexture;
  /** Redraw the turn dots under the numerals (one per revolution). */
  setRev(rev: number): void;
}

/**
 * One revolution of the VS6 scale around the hopper: ticks rising from the bottom edge, a long
 * one at each number with the numeral above it, a medium one halfway, short ones between, and
 * small dots under the numerals for the turn. u = 0 is the "0" mark; u runs the same way as
 * CylinderGeometry.
 */
export function hopperScale(
  numbersPerRev: number,
  linesPerNumber: number,
  dark: boolean,
): HopperScale {
  const W = 2048;
  const H = 430;
  const [c, g] = canvas(W, H);
  const t = tex(c);
  let last = -1;
  const setRev = (rev: number) => {
    if (rev === last || !g) return;
    last = rev;
    g.fillStyle = dark ? '#1c1c1e' : '#eeede9';
    g.fillRect(0, 0, W, H);
    const ink = dark ? '#c4c6c9' : '#3f4246';
    g.strokeStyle = ink;
    g.fillStyle = ink;
    const total = numbersPerRev * linesPerNumber;
    const half = linesPerNumber / 2;
    for (let i = 0; i < total; i++) {
      const x = (i / total) * W;
      const k = i % linesPerNumber;
      const len = k === 0 ? 0.44 : Number.isInteger(half) && k === half ? 0.27 : 0.15;
      g.lineWidth = k === 0 ? 4.4 : 3.2;
      g.beginPath();
      g.moveTo(x, H);
      g.lineTo(x, H * (1 - len));
      g.stroke();
      if (k === 0) {
        const top = H * (1 - len);
        const dots = Math.max(1, Math.min(6, rev));
        for (let d = 0; d < dots; d++) {
          g.beginPath();
          g.arc(x + (d - (dots - 1) / 2) * 13, top - 14, 4, 0, Math.PI * 2);
          g.fill();
        }
        g.font = '600 34px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillText(String(i / linesPerNumber), x, top - 30);
      }
    }
    t.needsUpdate = true;
  };
  setRev(1);
  return { texture: t, setRev };
}

/** A wordmark pressed into a painted surface (transparent around it), e.g. "varia". */
export function debossedText(text: string, dark: boolean, weight = 300): CanvasTexture {
  const W = 512;
  const H = 160;
  const [c, g] = canvas(W, H);
  if (g) {
    g.font = `${weight} 112px "Helvetica Neue", "Avenir Next", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Light catches the lower edge of the groove, the upper edge is in shadow.
    g.fillStyle = dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.75)';
    g.fillText(text, W / 2, H / 2 + 3);
    g.fillStyle = dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.17)';
    g.fillText(text, W / 2, H / 2);
  }
  return tex(c);
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

/**
 * The Mara X dual manometer (Lelit MC593): steam 0–3 bar over the top half and pump 0–16 bar
 * under the bottom half, both starting at nine o'clock, "bar" at the left. Same sweeps as
 * anim.steamNeedleAngle / pumpNeedleAngle.
 */
export function dualGaugeFace(): CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S, S);
  if (g) {
    const cx = S / 2;
    const cy = S / 2;
    g.fillStyle = '#fbfaf7';
    g.beginPath();
    g.arc(cx, cy, S / 2 - 2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#1b1b1b';
    g.fillStyle = '#1b1b1b';
    const r = S / 2 - 26;
    const tick = (a: number, len: number, w: number) => {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
      g.stroke();
    };
    const label = (a: number, text: string) => {
      g.font = '600 30px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, cx + Math.cos(a) * (r - 58), cy + Math.sin(a) * (r - 58));
    };
    // Canvas angles run clockwise from +x (y is down): the steam arc goes π → 2π over the top.
    for (let v = 0; v <= 30; v++) {
      const a = Math.PI + (v / 30) * Math.PI;
      const major = v % 5 === 0;
      tick(a, major ? 34 : 18, major ? 5 : 3);
      if (major && v > 0) label(a, String(v / 10));
    }
    // The pump arc goes π → 0 under the bottom.
    for (let v = 0; v <= 16; v++) {
      const a = Math.PI - (v / 16) * Math.PI;
      const major = v % 2 === 0;
      tick(a, major ? 34 : 18, major ? 5 : 3);
      if (major && v > 0) label(a, String(v));
    }
    g.font = '600 26px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('STEAM', cx, cy - 92);
    g.fillText('PUMP', cx, cy + 96);
    g.textAlign = 'left';
    g.fillText('0', cx - r + 40, cy - 18);
    g.fillText('bar', cx - r + 40, cy + 2);
    g.fillText('0', cx - r + 40, cy + 26);
  }
  return tex(c);
}

/**
 * The Mara X front-panel print, in panel millimetres (x from the centre, y up from the table):
 * the steam and water icons with their arcs above the knobs, the two pilot-light icons, the
 * power symbol, the lever's cup ↔ stop icon and the pressed pocket around the badge.
 */
export function maraxPanelPrint(o: {
  width: number;
  y0: number;
  y1: number;
  knobs: readonly [number, number][];
  leds: readonly [number, number][];
  power: readonly [number, number];
  lever: readonly [number, number];
  badge: readonly [number, number, number, number];
}): CanvasTexture {
  const K = 4; // px per mm
  const W = Math.round(o.width * K);
  const H = Math.round((o.y1 - o.y0) * K);
  const [c, g] = canvas(W, H);
  if (g) {
    const X = (x: number) => (x + o.width / 2) * K;
    const Y = (y: number) => (o.y1 - y) * K;
    g.strokeStyle = '#141414';
    g.fillStyle = '#141414';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 0.7 * K;
    for (const [i, [kx, ky]] of o.knobs.entries()) {
      // Arc over the knob (the direction to turn) and the icon above it.
      g.beginPath();
      g.arc(X(kx), Y(ky), 37 * K, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
      g.stroke();
      const ix = X(kx + (i === 0 ? 10 : -10));
      const iy = Y(ky + 48);
      if (i === 0) {
        // Steam: a nozzle with a puff.
        g.beginPath();
        g.moveTo(ix - 2 * K, iy - 4 * K);
        g.lineTo(ix - 3.5 * K, iy + 1 * K);
        g.moveTo(ix + 2 * K, iy - 4 * K);
        g.lineTo(ix + 3.5 * K, iy + 1 * K);
        g.moveTo(ix, iy - 5 * K);
        g.lineTo(ix, iy);
        g.stroke();
        g.beginPath();
        g.arc(ix - 3 * K, iy + 3 * K, 2.2 * K, 0, Math.PI * 2);
        g.arc(ix + 3 * K, iy + 3 * K, 2.2 * K, 0, Math.PI * 2);
        g.stroke();
      } else {
        drop(g, ix, iy, 3.2 * K);
      }
    }
    // Pilot lights: thermometer (ready) and tap (tank).
    const [t, w] = o.leds;
    if (t) {
      const x = X(t[0]);
      const y = Y(t[1] + 11);
      g.beginPath();
      g.moveTo(x - 1.2 * K, y + 2 * K);
      g.lineTo(x - 1.2 * K, y - 4 * K);
      g.arc(x, y - 4 * K, 1.2 * K, Math.PI, 0);
      g.lineTo(x + 1.2 * K, y + 2 * K);
      g.stroke();
      g.beginPath();
      g.arc(x, y + 3.6 * K, 2 * K, 0, Math.PI * 2);
      g.stroke();
    }
    if (w) {
      const x = X(w[0]);
      const y = Y(w[1] + 11);
      g.beginPath();
      g.moveTo(x - 4 * K, y - 3 * K);
      g.lineTo(x + 1 * K, y - 3 * K);
      g.lineTo(x + 1 * K, y - 1 * K);
      g.moveTo(x - 1.5 * K, y - 5 * K);
      g.lineTo(x - 1.5 * K, y - 3 * K);
      g.stroke();
      drop(g, x + 1 * K, y + 3 * K, 1.8 * K);
    }
    // Power symbol above the button.
    {
      const x = X(o.power[0]);
      const y = Y(o.power[1] + 15);
      g.beginPath();
      g.arc(x, y, 3.4 * K, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(x, y - 1.6 * K);
      g.lineTo(x, y + 1.6 * K);
      g.stroke();
    }
    // The lever: cup ↔ stop.
    {
      const x = X(o.lever[0]);
      const y = Y(o.lever[1]);
      g.lineWidth = 0.5 * K;
      g.strokeRect(x - 7 * K, y - 2 * K, 5 * K, 4 * K);
      g.beginPath();
      g.arc(x - 1.6 * K, y, 1.2 * K, -Math.PI / 2, Math.PI / 2);
      g.moveTo(x - 4 * K, y + 4 * K);
      g.quadraticCurveTo(x, y + 8 * K, x + 3 * K, y + 7 * K);
      g.stroke();
      drop(g, x + 6 * K, y + 7 * K, 1.6 * K);
      g.font = `${2.6 * K}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText('stop', x + 6 * K, y + 12.5 * K);
    }
    // The badge sits in a pressed pocket: shade above, light below.
    {
      const [bx, by, bw, bh] = o.badge;
      const x = X(bx - bw / 2 - 4);
      const y = Y(by + bh / 2 + 4);
      const w = (bw + 8) * K;
      const h = (bh + 8) * K;
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, 'rgba(0,0,0,0.22)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.04)');
      gr.addColorStop(1, 'rgba(255,255,255,0.35)');
      g.lineWidth = 1.2 * K;
      g.strokeStyle = gr;
      roundRect(g, x, y, w, h, 6 * K);
      g.stroke();
    }
  }
  return tex(c);
}

/** The Mara X V1 badge: white LELIT on red. */
export function lelitBadge(): CanvasTexture {
  const [c, g] = canvas(384, 120);
  if (g) {
    g.fillStyle = '#c4161c';
    roundRect(g, 0, 0, 384, 120, 30);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '800 78px "Arial Rounded MT Bold", "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('LELIT', 192, 64);
  }
  return tex(c);
}

function drop(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - 2.4 * r);
  g.quadraticCurveTo(x + r * 1.1, y - 0.6 * r, x + r, y);
  g.arc(x, y, r, 0, Math.PI);
  g.quadraticCurveTo(x - r * 1.1, y - 0.6 * r, x, y - 2.4 * r);
  g.stroke();
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
