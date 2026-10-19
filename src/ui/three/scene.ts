/**
 * Scene runtime for one 3D view. The renderer draws only while something moves (streams,
 * grounds, a lever or the hopper turning, the camera easing) and pauses when the canvas is
 * off screen or the page is hidden. Everything is disposed on unmount (iOS limits the number
 * of live WebGL contexts).
 */
import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sphere,
  type Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { DialSpec } from '../../core/types';
import { approach, brewPressureBar, gaugeAngle, grindRateGps } from './anim';
import { VS6 } from './dims';
import { buildBeans, buildGrounds, buildStreams } from './effects';
import { makeMaterials } from './materials';
import { buildCup } from './models/cup';
import { buildMarax } from './models/marax';
import { buildThemis } from './models/themis';
import { buildDosingCup, buildVs6 } from './models/vs6';

export type View = 'setup' | 'weigh' | 'grind' | 'marax';

/** What the scene shows, read every frame (plain numbers, no signals). */
export interface LiveState {
  /** Scale reading (display), g. */
  scaleG: number | null;
  /** Espresso in the cup (tared shot weight), g. */
  cupG: number;
  /** Live flow while pulling, g/s. */
  flowGps: number;
  /** Lever up: the pump is running. */
  running: boolean;
  /** Seconds into the pull (gauge ramp). */
  shotTimeS: number;
  rpm: number;
  /** Hopper rotation that brings the dial setting to the index (anim.hopperAngle). */
  hopperAngle: number;
  rev: number;
  tempSwitch: 0 | 1 | 2;
  doseG: number;
  /** 0..1 while the VS6 grinds the dose (grind view); null when not grinding. */
  grindProgress: number | null;
}

export interface SceneOptions {
  view: View;
  grinderColor: 'black' | 'white';
  reducedMotion: boolean;
  spec: DialSpec;
  getState: () => LiveState;
}

export interface SceneHandle {
  resetView(): void;
  dispose(): void;
}

/** Viewing direction per view (from the target towards the camera); distance is fitted. */
const CAMERAS: Record<View, [number, number, number]> = {
  marax: [0.42, 0.36, 0.83],
  grind: [0.5, 0.42, 0.76],
  weigh: [0.2, 0.8, 0.58],
  setup: [0.24, 0.36, 0.9],
};

function fmtG(g: number | null): string {
  if (g === null || !Number.isFinite(g)) return '--.- g';
  return `${g.toFixed(1)} g`;
}

export function mountScene(canvas: HTMLCanvasElement, o: SceneOptions): SceneHandle {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env: Texture = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.85;
  const key = new DirectionalLight(0xffffff, 1.3);
  key.position.set(-300, 700, 500);
  scene.add(key);

  const mats = makeMaterials(o.grinderColor);
  const disposers: (() => void)[] = [];
  const view = o.view;

  // ---- compose the view ----
  const showMarax = view === 'marax' || view === 'setup';
  const showVs6 = view !== 'marax';
  const marax = showMarax ? buildMarax(mats) : null;
  const vs6 = showVs6 ? buildVs6(mats, o.spec, o.grinderColor === 'black') : null;
  const maraxRoot = new Group();
  const vs6Root = new Group();
  if (marax) {
    maraxRoot.add(marax.group);
    disposers.push(marax.dispose);
    if (view === 'setup') maraxRoot.position.set(-150, 0, 0);
    scene.add(maraxRoot);
  }
  if (vs6) {
    vs6Root.add(vs6.group);
    disposers.push(vs6.dispose);
    if (view === 'setup') vs6Root.position.set(165, 0, 205 - VS6.depth / 2 - 30);
    if (view === 'weigh') vs6Root.position.set(-95, 0, -20);
    scene.add(vs6Root);
  }
  // Scale + espresso cup on the drip tray.
  const themis = buildThemis(mats);
  disposers.push(themis.dispose);
  const cup = marax ? buildCup(mats) : null;
  if (marax && cup) {
    const under = marax.underGroup.clone().add(maraxRoot.position);
    themis.group.position.copy(under);
    cup.group.position.set(under.x, under.y + themis.topY, under.z);
    scene.add(themis.group, cup.group);
  } else if (view === 'weigh') {
    themis.group.position.set(115, 0, 50);
    scene.add(themis.group);
  }
  // Weigh view: the dosing cup with beans on the scale, its bay on the VS6 empty.
  let beans: ReturnType<typeof buildBeans> | null = null;
  /** What the camera frames: the whole scene, or just the scale and cup while weighing. */
  const frameRoots: Object3D[] = [scene];
  if (view === 'weigh' && vs6) {
    vs6.setCupInBay(false);
    const dc = buildDosingCup(mats);
    dc.group.position.set(115, themis.topY, 50);
    scene.add(dc.group);
    frameRoots.splice(0, 1, themis.group, dc.group);
    beans = buildBeans(mats.beans, VS6.cupInnerR, 0);
    beans.mesh.position.set(115, themis.topY, 50);
    scene.add(beans.mesh);
    disposers.push(beans.dispose);
  }
  const streams = marax ? buildStreams(mats.stream) : null;
  if (streams) {
    for (const m of streams.meshes) scene.add(m);
    disposers.push(streams.dispose);
  }
  const grounds = view === 'grind' && vs6 ? buildGrounds(mats.grounds) : null;
  if (grounds) {
    scene.add(grounds.mesh);
    disposers.push(grounds.dispose);
  }

  // ---- camera and controls ----
  const camera = new PerspectiveCamera(30, 1, 10, 6000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minPolarAngle = 0.55;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  // Vertical swipes scroll the page on a phone; horizontal drags turn the model.
  canvas.style.touchAction = 'pan-y';
  // Frame the models (not their shadows) for the canvas's aspect: the bounding sphere fits
  // the narrower of the two fields of view.
  scene.updateMatrixWorld(true);
  const bounds = new Box3();
  const tmp = new Box3();
  for (const root of frameRoots) {
    root.traverse((obj) => {
      if (!(obj instanceof Mesh) || obj instanceof InstancedMesh || obj.userData.skipBounds) return;
      if (!obj.visible) return;
      obj.geometry.computeBoundingBox();
      const bb = obj.geometry.boundingBox;
      if (bb) bounds.union(tmp.copy(bb).applyMatrix4(obj.matrixWorld));
    });
  }
  const sphere = bounds.getBoundingSphere(new Sphere());
  // Small framings (the scale and cup while weighing) keep some context around them.
  sphere.radius = Math.max(sphere.radius, 170);
  const fitDistance = () => {
    const v = (camera.fov * Math.PI) / 180;
    const h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
    return (sphere.radius / Math.sin(Math.min(v, h) / 2)) * 0.92;
  };
  const resetView = () => {
    const dir = new Vector3(...CAMERAS[view]).normalize();
    controls.target.copy(sphere.center);
    const dist = fitDistance();
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    controls.minDistance = dist * 0.4;
    controls.maxDistance = dist * 1.5;
    controls.update();
    dirty = true;
  };
  let dirty = true;
  controls.addEventListener('change', () => {
    dirty = true;
  });
  const onDouble = () => {
    userMoved = false;
    resetView();
  };
  canvas.addEventListener('dblclick', onDouble);

  // ---- sizing and visibility ----
  let userMoved = false;
  controls.addEventListener('start', () => {
    userMoved = true;
  });
  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Re-frame for the new aspect unless the user has turned or zoomed the view.
    if (!userMoved) resetView();
    dirty = true;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  let onScreen = true;
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    schedule();
  });
  io.observe(canvas);
  const onVisibility = () => schedule();
  document.addEventListener('visibilitychange', onVisibility);

  // ---- animation state ----
  let hopper = 0;
  let lever = 0;
  let pump = gaugeAngle(0, 16);
  let lastT = performance.now();
  let raf = 0;
  let disposed = false;
  const spoutWorld = (marax?.spouts ?? []).map((p) => p.clone().add(maraxRoot.position));
  const chuteWorld = vs6 ? vs6.chuteExit.clone().add(vs6Root.position) : new Vector3();
  let lastScaleText = '';

  function step(dtS: number, tS: number): boolean {
    const s = o.getState();
    let active = false;
    if (vs6) {
      // Shortest way round to the target angle.
      const target = -s.hopperAngle;
      let d = target - hopper;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const next = approach(hopper, hopper + d, dtS, 0.3);
      if (Math.abs(next - hopper) > 1e-4) active = true;
      hopper = next;
      vs6.setHopper(hopper);
      vs6.setRev(s.rev);
      vs6.setRpm(s.rpm);
    }
    if (marax) {
      const nl = approach(lever, s.running ? 1 : 0, dtS, 0.12);
      if (Math.abs(nl - lever) > 1e-4) active = true;
      lever = nl;
      marax.setLever(lever);
      const np = approach(pump, gaugeAngle(brewPressureBar(s.shotTimeS, s.running), 16), dtS, 0.35);
      if (Math.abs(np - pump) > 1e-4) active = true;
      pump = np;
      marax.setGauges(pump, gaugeAngle(1.2, 3));
      marax.setTempSwitch(s.tempSwitch);
    }
    const text = fmtG(s.scaleG);
    if (text !== lastScaleText) {
      lastScaleText = text;
      themis.setText(text);
      active = true;
    }
    if (cup && streams) {
      cup.setGrams(s.cupG);
      const surface = cup.group.position.y + cup.surfaceY();
      const flow = o.reducedMotion ? 0 : s.running ? s.flowGps : 0;
      if (streams.update(dtS, flow, spoutWorld, surface, tS)) active = true;
    }
    if (beans) beans.set(Math.max(0, s.scaleG ?? 0));
    if (vs6 && view === 'grind') {
      const p = s.grindProgress;
      const ground = p === null ? 0 : p;
      vs6.setFill((ground * s.doseG) / VS6.cupCapacityG);
      const rate = p !== null && p < 1 && !o.reducedMotion ? grindRateGps(s.rpm) : 0;
      if (grounds) {
        const floor = vs6Root.position.y + vs6.fillTopY();
        if (grounds.update(dtS, rate, chuteWorld, floor)) active = true;
      }
      if (p !== null && p < 1) active = true;
    }
    return active;
  }

  function frame(now: number): void {
    raf = 0;
    if (disposed) return;
    const dtS = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    const moving = step(dtS, now / 1000);
    const cam = controls.update();
    if (moving || cam || dirty) {
      renderer.render(scene, camera);
      dirty = false;
    }
    schedule();
  }

  function schedule(): void {
    if (disposed || raf !== 0) return;
    if (!onScreen || document.hidden) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  schedule();

  return {
    resetView,
    dispose() {
      disposed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('dblclick', onDouble);
      controls.dispose();
      for (const d of disposers) d();
      const seenMats = new Set<Material>();
      scene.traverse((obj) => {
        if (obj instanceof Mesh || obj instanceof InstancedMesh) {
          obj.geometry.dispose();
          const m = obj.material;
          for (const mm of Array.isArray(m) ? m : [m]) seenMats.add(mm);
        }
      });
      for (const m of seenMats) m.dispose();
      mats.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
