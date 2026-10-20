/**
 * Physically based materials for the VS6, the Mara X and the Themis Mini. Lit by a PMREM
 * RoomEnvironment (scene.ts), so metals pick up soft studio reflections without an HDR file.
 */
import {
  CanvasTexture,
  type Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three';

export interface Mats {
  /** VS6 powder-coated aluminium (black or white). */
  alu: MeshStandardMaterial;
  aluDark: MeshStandardMaterial;
  /** VS6 machined rings (index collar, feed ring, cup band): satin silver or dark anodised. */
  ring: MeshStandardMaterial;
  /** Brushed stainless (the dosing cup's inside). */
  stainless: MeshPhysicalMaterial;
  /** Gloss black glass (display windows). */
  glossBlack: MeshPhysicalMaterial;
  /** Polished black resin (Mara X knobs and lever knob). */
  resin: MeshPhysicalMaterial;
  /** Polished wire (grates). */
  wire: MeshStandardMaterial;
  /** Unlit darkness (the throat into the burrs). */
  void: MeshStandardMaterial;
  /** Mara X brushed stainless (anisotropic). */
  steel: MeshPhysicalMaterial;
  chrome: MeshStandardMaterial;
  blackPlastic: MeshStandardMaterial;
  rubber: MeshStandardMaterial;
  wood: MeshStandardMaterial;
  glass: MeshPhysicalMaterial;
  coffee: MeshPhysicalMaterial;
  crema: MeshStandardMaterial;
  stream: MeshPhysicalMaterial;
  grounds: MeshStandardMaterial;
  beans: MeshStandardMaterial;
  shadow: MeshStandardMaterial;
  dispose(): void;
}

/** Soft round contact shadow (a radial gradient), so objects sit on the table. */
function shadowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    r.addColorStop(0, 'rgba(0,0,0,0.55)');
    r.addColorStop(0.6, 'rgba(0,0,0,0.18)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function makeMaterials(grinder: 'black' | 'white'): Mats {
  const black = grinder === 'black';
  const shadowMap = shadowTexture();
  const all: Material[] = [];
  const keep = <T extends Material>(m: T): T => {
    all.push(m);
    return m;
  };
  const mats: Omit<Mats, 'dispose'> = {
    alu: keep(
      new MeshStandardMaterial({
        color: black ? 0x1c1c1e : 0xecebe7,
        roughness: black ? 0.58 : 0.62,
        metalness: 0.08,
      }),
    ),
    aluDark: keep(
      new MeshStandardMaterial({
        color: black ? 0x0e0e10 : 0xc9c7c2,
        roughness: 0.5,
        metalness: 0.2,
      }),
    ),
    ring: keep(
      new MeshStandardMaterial({
        color: black ? 0x2a2b2e : 0xd6d8db,
        roughness: black ? 0.42 : 0.34,
        metalness: black ? 0.55 : 0.85,
      }),
    ),
    stainless: keep(
      new MeshPhysicalMaterial({
        color: 0xbcc0c4,
        metalness: 1,
        roughness: 0.3,
        anisotropy: 0.5,
      }),
    ),
    glossBlack: keep(
      new MeshPhysicalMaterial({
        color: 0x050506,
        roughness: 0.12,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
      }),
    ),
    resin: keep(
      new MeshPhysicalMaterial({
        color: 0x0c0c0d,
        roughness: 0.22,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      }),
    ),
    wire: keep(new MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.16 })),
    void: keep(new MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0 })),
    steel: keep(
      new MeshPhysicalMaterial({
        color: 0xa7acb2,
        metalness: 1,
        roughness: 0.3,
        anisotropy: 0.7,
        anisotropyRotation: Math.PI / 2,
      }),
    ),
    chrome: keep(new MeshStandardMaterial({ color: 0xf1f3f5, metalness: 1, roughness: 0.07 })),
    blackPlastic: keep(
      new MeshStandardMaterial({ color: 0x151515, roughness: 0.42, metalness: 0 }),
    ),
    rubber: keep(new MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.92, metalness: 0 })),
    wood: keep(new MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.55, metalness: 0 })),
    glass: keep(
      new MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.04,
        transparent: true,
        opacity: 0.22,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        depthWrite: false,
      }),
    ),
    coffee: keep(
      new MeshPhysicalMaterial({ color: 0x2a1207, roughness: 0.18, metalness: 0, clearcoat: 0.6 }),
    ),
    crema: keep(new MeshStandardMaterial({ color: 0xb8773f, roughness: 0.62, metalness: 0 })),
    stream: keep(
      new MeshPhysicalMaterial({
        color: 0x4a220c,
        roughness: 0.15,
        metalness: 0,
        clearcoat: 0.8,
        transparent: true,
        opacity: 0.92,
      }),
    ),
    grounds: keep(new MeshStandardMaterial({ color: 0x4b2d1b, roughness: 0.95, metalness: 0 })),
    beans: keep(new MeshStandardMaterial({ color: 0x3a2214, roughness: 0.48, metalness: 0 })),
    shadow: keep(
      new MeshStandardMaterial({
        map: shadowMap,
        transparent: true,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
        color: 0x000000,
        opacity: 1,
      }),
    ),
  };
  return {
    ...mats,
    dispose() {
      for (const m of all) m.dispose();
      shadowMap.dispose();
    },
  };
}
