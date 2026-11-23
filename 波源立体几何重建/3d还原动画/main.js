import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG, latestEmission, waveCapacity, waveRadius, waveOpacity, sectionRadius } from './wave-model.js';
import { createTimeline } from '../3d/timeline.js';
import { BASE_FOV, mountLens } from '../3d/lens.js';

const { colors, sources, maxRadius, sectionCenter, sectionExtent } = CONFIG;
const sceneCanvas = document.querySelector('#scene');
const sectionCanvas = document.querySelector('#section');
const scaleBar = document.querySelector('#scale-bar');
const showPlane = document.querySelector('#show-plane');

const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true, powerPreference: 'low-power' });
const scene = new THREE.Scene();
scene.background = new THREE.Color(colors.background);
const planeGuides = new THREE.Group();
planeGuides.visible = showPlane.checked;
scene.add(planeGuides);
const sourcePositions = sources.map(({ x, y, z }) => new THREE.Vector3(x, y, z));
const sceneCenter = new THREE.Vector3(150, 0, 0);
const sceneRadius = maxRadius + Math.max(...sourcePositions.map(position => position.distanceTo(sceneCenter)));
const initialCameraDistance = 950;
const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 1, sceneRadius * 14);
camera.up.set(0, 0, 1);
camera.position.set(sceneCenter.x + initialCameraDistance, sceneCenter.y, sceneCenter.z);

const controls = new OrbitControls(camera, sceneCanvas);
controls.target.copy(sceneCenter);
controls.minDistance = 12;
controls.maxDistance = sceneRadius * 9;
controls.enableDamping = true;
controls.update();

const gridExtent = maxRadius * 2.1;
const grid = new THREE.Mesh(
  new THREE.PlaneGeometry(gridExtent * 2, gridExtent * 2),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uGrid: { value: new THREE.Color(colors.grid) },
      uAxes: { value: new THREE.Color(colors.axes) },
      uExtent: { value: gridExtent },
    },
    vertexShader: /* glsl */ `
      varying vec2 vPlane;
      varying vec2 vWorldXY;
      void main() {
        vPlane = position.xy;
        vWorldXY = (modelMatrix * vec4(position, 1.0)).xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uGrid;
      uniform vec3 uAxes;
      uniform float uExtent;
      varying vec2 vPlane;
      varying vec2 vWorldXY;

      float gridLine(float spacing, vec2 footprint) {
        vec2 nearest = abs(fract(vWorldXY / spacing + 0.5) - 0.5) * spacing;
        vec2 line = (1.0 - smoothstep(0.0, 1.15, nearest / footprint))
          * (1.0 - smoothstep(vec2(spacing * 0.25), vec2(spacing * 0.6), footprint));
        return max(line.x, line.y);
      }

      void main() {
        vec2 footprint = max(fwidth(vPlane), vec2(0.001));
        float fine = gridLine(25.0, footprint);
        float major = gridLine(100.0, footprint);
        vec2 axis = 1.0 - smoothstep(0.0, 1.3, abs(vWorldXY) / footprint);
        float axes = max(axis.x, axis.y);
        float edge = 1.0 - smoothstep(uExtent * 0.48, uExtent, length(vPlane));
        gl_FragColor = vec4(mix(uGrid, uAxes, axes), max(0.16 * fine, 0.31 * major + 0.29 * axes) * edge);
        #include <colorspace_fragment>
      }
    `,
  }),
);
grid.position.set(sceneCenter.x, sceneCenter.y, 0);
grid.renderOrder = 0;
planeGuides.add(grid);

const outerSpheres = new Float32Array(sources.length * 4);
const dimmedSources = new Set(['source-2', 'origin', 'source-4']);
const activeWaves = [];
const viewDirection = new THREE.Vector3();
const shellGeometry = new THREE.SphereGeometry(1, 96, 56);
const markerGeometry = new THREE.SphereGeometry(1, 16, 10);
const shellMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthTest: true,
  depthWrite: false,
  side: THREE.FrontSide,
  blending: THREE.NormalBlending,
  defines: { SOURCE_COUNT: sources.length },
  uniforms: {
    uShell: { value: new THREE.Color() },
    uRim: { value: new THREE.Color() },
    uGridLine: { value: new THREE.Color() },
    uGridRim: { value: new THREE.Color() },
    uIntersection: { value: new THREE.Color() },
    uInnerEdge: { value: new THREE.Color() },
    uInnerCenter: { value: new THREE.Color() },
    uOpacity: { value: 0 },
    uShellFill: { value: 1 },
    uIntersects: { value: 0 },
    uNewest: { value: 0 },
    uOuterSpheres: { value: outerSpheres },
    uSourceIndex: { value: 0 },
    uRadius: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    varying vec2 vGrid;

    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      vGrid = uv * vec2(96.0, 48.0);
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uShell;
    uniform vec3 uRim;
    uniform vec3 uGridLine;
    uniform vec3 uGridRim;
    uniform vec3 uIntersection;
    uniform vec3 uInnerEdge;
    uniform vec3 uInnerCenter;
    uniform float uOpacity;
    uniform float uShellFill;
    uniform float uIntersects;
    uniform float uNewest;
    uniform vec4 uOuterSpheres[SOURCE_COUNT];
    uniform int uSourceIndex;
    uniform float uRadius;
    varying vec3 vWorldPos;
    varying vec2 vGrid;

    float gridLine(float coordinate, float footprint, float width) {
      float nearest = abs(fract(coordinate + 0.5) - 0.5);
      float pixel = nearest / max(footprint, 0.0001);
      float coverage = clamp(0.5 + 0.5 * width - pixel, 0.0, width);
      return coverage * (1.0 - smoothstep(0.27, 0.52, footprint));
    }

    vec2 rayCoordinates(vec3 center, vec3 ray) {
      vec3 offset = center - cameraPosition;
      float along = dot(offset, ray);
      vec3 perpendicular = offset - along * ray;
      return vec2(along, dot(perpendicular, perpendicular));
    }

    void overlay(inout vec4 surface, vec3 color, float coverage) {
      float alpha = coverage + surface.a * (1.0 - coverage);
      surface = vec4(mix(surface.rgb, color, coverage / max(alpha, 0.00001)), alpha);
    }

    void main() {
      vec3 center = uOuterSpheres[uSourceIndex].xyz;
      vec3 toFragment = vWorldPos - cameraPosition;
      float fragmentDepth = length(toFragment);
      vec3 ray = toFragment / max(fragmentDepth, 0.0001);
      vec2 self = rayCoordinates(center, ray);
      float surfaceDepth = self.x - sqrt(max(0.0, uRadius * uRadius - self.y));
      vec3 surfacePoint = cameraPosition + surfaceDepth * ray;
      vec3 normal = normalize(surfacePoint - center);
      float facing = clamp(dot(normal, -ray), 0.0, 1.0);
      float grazing = 1.0 - facing;
      float fresnel = grazing * grazing;
      vec2 footprint = fwidth(vGrid);
      float planePixel = max(fwidth(surfacePoint.z), 0.05);
      bool occluded = false;
      float contact = 0.0;
      float contactShade = 0.0;
      for (int j = 0; j < SOURCE_COUNT; j++) {
        vec4 other = uOuterSpheres[j];
        if (j == uSourceIndex || other.w <= 0.0) continue;
        vec2 projected = rayCoordinates(other.xyz, ray);
        float discriminant = other.w * other.w - projected.y;
        float entry = projected.x - sqrt(max(0.0, discriminant));
        occluded = occluded || (discriminant > 0.0 && entry > 0.05 && entry < surfaceDepth - 0.35);

        float along = surfaceDepth - projected.x;
        float gap = sqrt(projected.y + along * along) - other.w;
        float pixel = max(fwidth(gap), 0.0001);
        float distance = gap / pixel;
        contact = max(contact, 1.0 - smoothstep(0.20, 1.0, abs(distance)));
        float fromCut = abs(distance);
        float darkEdge = smoothstep(0.40, 1.0, fromCut) * (1.0 - smoothstep(1.15, 3.2, fromCut));
        contactShade = max(contactShade, darkEdge * (distance < 0.0 ? 1.0 : 0.65));
      }
      // Evaluate derivatives before discarding so adjacent lanes keep smooth cut edges.
      if (occluded) discard;

      vec4 surface;
      float shade = 1.0 - 0.24 * contactShade;
      if (uNewest > 0.5) {
        vec3 inner = mix(uInnerEdge, uInnerCenter, smoothstep(0.0, 1.0, facing));
        surface = vec4(inner * shade, mix(0.07, 0.65, smoothstep(0.02, 0.56, facing)));
      } else {
        float poleGlow = smoothstep(0.981, 1.0, abs(normal.y)) * smoothstep(0.04, 0.59, facing);
        vec3 shell = mix(uShell, uRim, 0.28 * fresnel + 0.14 * poleGlow);
        float fill = mix(0.06, 0.53, fresnel) + 0.05 * poleGlow;
        surface = vec4(shell * shade, fill * uShellFill);
        float width = mix(0.45, 0.65, fresnel);
        float poleDistance = min(vGrid.y, 48.0 - vGrid.y);
        float meridians = gridLine(vGrid.x, footprint.x, width) * smoothstep(0.15, 1.15, poleDistance);
        float parallels = gridLine(vGrid.y, footprint.y, width);
        vec3 wire = mix(uGridLine, uGridRim, 0.87 * fresnel + 0.13 * poleGlow);
        overlay(surface, wire, max(meridians, parallels) * mix(0.82, 1.0, fresnel) * shade);
      }
      overlay(surface, uIntersection, 0.80 * contact * uShellFill);
      if (uIntersects > 0.0) {
        float ring = 1.0 - smoothstep(0.35, 1.85, abs(surfacePoint.z) / planePixel);
        overlay(surface, uIntersection, 0.74 * ring);
      }
      surface.a *= uOpacity;
      gl_FragColor = surface;
      #include <colorspace_fragment>
    }
  `,
});

const coreTextureCanvas = document.createElement('canvas');
coreTextureCanvas.width = coreTextureCanvas.height = 64;
const coreContext = coreTextureCanvas.getContext('2d');
const coreGlow = coreContext.createRadialGradient(32, 32, 0, 32, 32, 32);
coreGlow.addColorStop(0, '#ffffff');
coreGlow.addColorStop(0.14, '#ffffff');
coreGlow.addColorStop(0.25, '#ffffff8c');
coreGlow.addColorStop(0.52, '#ffffff30');
coreGlow.addColorStop(1, '#ffffff00');
coreContext.fillStyle = coreGlow;
coreContext.fillRect(0, 0, 64, 64);
const coreTexture = new THREE.CanvasTexture(coreTextureCanvas);

function createSurfaceMaterial(source, index, newest) {
  const material = shellMaterial.clone();
  const uniforms = material.uniforms;
  uniforms.uShell.value.set(source.colors.shell);
  uniforms.uRim.value.set(source.colors.rim);
  uniforms.uGridLine.value.set(source.colors.grid);
  uniforms.uGridRim.value.set(source.colors.gridRim);
  uniforms.uIntersection.value.set(source.colors.intersection);
  uniforms.uInnerEdge.value.set(source.colors.innerEdge);
  uniforms.uInnerCenter.value.set(source.colors.innerCenter);
  uniforms.uNewest.value = Number(newest);
  uniforms.uSourceIndex.value = index;
  uniforms.uOuterSpheres.value = outerSpheres;
  return material;
}

const sourceViews = sources.map((source, index) => {
  const position = sourcePositions[index];
  const dimInterior = dimmedSources.has(source.id);
  const outerRadiusIndex = 4 * index + 3;
  outerSpheres.set([position.x, position.y, position.z, -1], 4 * index);
  const coreMaterial = createSurfaceMaterial(source, index, true);
  coreMaterial.uniforms.uInnerCenter.value.set(source.colors.core);
  coreMaterial.uniforms.uRadius.value = 6;
  coreMaterial.uniforms.uOpacity.value = 0.8;
  const core = new THREE.Mesh(markerGeometry, coreMaterial);
  core.position.copy(position);
  core.scale.setScalar(coreMaterial.uniforms.uRadius.value);
  core.visible = !dimInterior;
  scene.add(core);

  if (source.z !== 0) {
    const projectionMaterial = new THREE.SpriteMaterial({
      map: coreTexture, color: source.colors.section, opacity: 0.4, depthWrite: false,
    });
    const projection = new THREE.Sprite(projectionMaterial);
    projection.position.set(source.x, source.y, 0);
    projection.scale.set(32, 32, 1);
    const heightMaterial = new THREE.LineDashedMaterial({
      color: source.colors.section, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const height = new THREE.Line(new THREE.BufferGeometry().setFromPoints([position, projection.position]), heightMaterial);
    height.computeLineDistances();
    planeGuides.add(height, projection);
  }

  // Each source recycles its own slots at its configured emission interval.
  const waves = Array.from({ length: waveCapacity(source) }, (_, waveIndex) => {
    const material = createSurfaceMaterial(source, index, !dimInterior && waveIndex === 0);
    const mesh = new THREE.Mesh(shellGeometry, material);
    mesh.position.copy(position);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, uniforms: material.uniforms, opacity: 0, section: null, radius: 0, depth: 0 };
  });
  return { source, core, waves, outerRadiusIndex, dimInterior, sectionActive: false };
});
shellMaterial.dispose();

const sectionContext = sectionCanvas.getContext('2d', { alpha: false });
const sectionGrid = document.createElement('canvas');
const gridContext = sectionGrid.getContext('2d', { alpha: false });
let sectionWidth = 0;
let sectionHeight = 0;
let sectionScale = 0;
let sectionDirty = true;
let sceneDirty = true;

function resizeScene({ width, height }) {
  const aspect = width / height;
  const offsetX = aspect > 1.1 ? width * 0.035 : 0;
  const offsetY = aspect < 0.85 ? height * 0.075 : 0;
  if (camera.view === null && aspect < 1) {
    camera.position.x = sceneCenter.x + initialCameraDistance / aspect;
    controls.update();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  camera.setViewOffset(width, height, offsetX, offsetY, width, height);
  sceneDirty = true;
}

function resizeSection({ width, height }) {
  const dpr = window.devicePixelRatio || 1;
  sectionWidth = width;
  sectionHeight = height;
  const inset = Math.max(7, width * 0.045);
  const half = Math.min(width, height) / 2 - inset;
  const centerX = width / 2;
  const centerY = height / 2;
  sectionScale = half / sectionExtent;
  const originX = centerX - sectionCenter.x * sectionScale;
  const originY = centerY + sectionCenter.y * sectionScale;
  sectionCanvas.width = sectionGrid.width = Math.round(width * dpr);
  sectionCanvas.height = sectionGrid.height = Math.round(height * dpr);
  gridContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  sectionContext.setTransform(dpr, 0, 0, dpr, 0, 0);

  gridContext.fillStyle = colors.sectionBackground;
  gridContext.fillRect(0, 0, width, height);
  gridContext.strokeStyle = colors.sectionGrid;
  gridContext.lineWidth = 1;
  gridContext.beginPath();
  for (let x = Math.ceil((sectionCenter.x - sectionExtent) / 50) * 50; x <= sectionCenter.x + sectionExtent; x += 50) {
    const pixelX = originX + x * sectionScale;
    gridContext.moveTo(pixelX, centerY - half);
    gridContext.lineTo(pixelX, centerY + half);
  }
  for (let y = Math.ceil((sectionCenter.y - sectionExtent) / 50) * 50; y <= sectionCenter.y + sectionExtent; y += 50) {
    const pixelY = originY - y * sectionScale;
    gridContext.moveTo(centerX - half, pixelY);
    gridContext.lineTo(centerX + half, pixelY);
  }
  gridContext.stroke();

  gridContext.strokeStyle = colors.sectionAxes;
  gridContext.beginPath();
  gridContext.moveTo(centerX - half, originY);
  gridContext.lineTo(centerX + half, originY);
  gridContext.moveTo(originX, centerY - half);
  gridContext.lineTo(originX, centerY + half);
  gridContext.stroke();
  gridContext.fillStyle = colors.sectionLabels;
  gridContext.font = '11px monospace';
  gridContext.fillText('X', centerX + half - 8, originY - 5);
  gridContext.fillText('Y', originX + 5, centerY - half + 11);
  for (const view of sourceViews) {
    view.sectionX = originX + view.source.x * sectionScale;
    view.sectionY = originY - view.source.y * sectionScale;
  }
  scaleBar.style.width = `${CONFIG.scaleLength * sectionScale}px`;
  sectionDirty = true;
}

function drawSection() {
  const ctx = sectionContext;
  const half = sectionExtent * sectionScale;
  ctx.drawImage(sectionGrid, 0, 0, sectionWidth, sectionHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sectionWidth / 2 - half, sectionHeight / 2 - half, 2 * half, 2 * half);
  ctx.clip();
  for (const { source, sectionX, sectionY, waves } of sourceViews) {
    ctx.strokeStyle = source.colors.section;
    for (const { section, opacity } of waves) {
      if (section === null || section === 0) continue;
      ctx.beginPath();
      ctx.arc(sectionX, sectionY, section * sectionScale, 0, 2 * Math.PI);
      ctx.globalAlpha = 0.22 * opacity;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.globalAlpha = 0.92 * opacity;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }
  ctx.font = '11px sans-serif';
  for (const { source, sectionX, sectionY, sectionActive } of sourceViews) {
    ctx.fillStyle = source.colors.section;
    if (sectionActive) {
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(sectionX, sectionY, 6, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = sectionActive ? 1 : 0.38;
    ctx.beginPath();
    ctx.arc(sectionX, sectionY, 2.4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillText(source.label, sectionX + 7, sectionY - 6);
  }
  ctx.restore();
}

let lastTime = NaN;

function updateWaves(time) {
  activeWaves.length = 0;
  for (const view of sourceViews) {
    const { source, waves, outerRadiusIndex, dimInterior } = view;
    const latest = latestEmission(time, source);
    let outerRadius = -1;
    view.sectionActive = false;
    // The oldest active wave is the outer shell, even if it is the only wave.
    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      const radius = waveRadius(time, latest - i, source);
      wave.opacity = radius === null ? 0 : waveOpacity(radius);
      wave.section = wave.opacity > 0 ? sectionRadius(radius, source.z) : null;
      view.sectionActive ||= wave.section !== null;
      const active = radius > 0 && wave.opacity > 0;
      const isOuter = active && outerRadius < 0;
      if (isOuter) outerRadius = radius;
      const dimLayer = dimInterior && !isOuter;
      wave.mesh.visible = active && (!dimLayer || i > 0);
      if (wave.mesh.visible) {
        wave.radius = radius;
        wave.mesh.scale.setScalar(radius);
        wave.uniforms.uRadius.value = radius;
        wave.uniforms.uOpacity.value = wave.opacity * (dimLayer ? 0.22 : 1);
        wave.uniforms.uShellFill.value = Number(!dimLayer);
        wave.uniforms.uIntersects.value = Number(showPlane.checked && wave.section !== null);
        activeWaves.push(wave);
      }
    }
    outerSpheres[outerRadiusIndex] = outerRadius;
  }
}

function sortTransparentSurfaces() {
  camera.getWorldDirection(viewDirection);
  // Front-surface depth also puts smaller concentric shells behind their outer skins.
  for (const wave of activeWaves) wave.depth = wave.mesh.position.dot(viewDirection) - wave.radius;
  activeWaves.sort((a, b) => b.depth - a.depth);
  for (let i = 0; i < activeWaves.length; i++) activeWaves[i].mesh.renderOrder = i + 1;
  for (const { core } of sourceViews) {
    if (!core.visible) continue;
    const depth = core.position.dot(viewDirection) - core.scale.x;
    const nearer = activeWaves.findIndex(wave => wave.depth < depth);
    core.renderOrder = (nearer < 0 ? activeWaves.length : nearer) + 0.5;
  }
}

function render(now) {
  controls.update();
  const time = timeline.tick(now);
  if (lastTime !== time) {
    updateWaves(time);
    lastTime = time;
    sceneDirty = sectionDirty = true;
  }
  if (sceneDirty) {
    sortTransparentSurfaces();
    renderer.render(scene, camera);
    sceneDirty = false;
  }
  if (sectionDirty) {
    drawSection();
    sectionDirty = false;
  }
  requestAnimationFrame(render);
}

controls.addEventListener('change', () => { sceneDirty = true; });
const setLensZoom = mountLens(document.querySelector('#lens'), camera, () => { sceneDirty = true; });
showPlane.addEventListener('change', () => {
  planeGuides.visible = showPlane.checked;
  lastTime = NaN;
});

function setCamera(target, offset) {
  controls.enableDamping = false;
  controls.update();
  controls.target.copy(target);
  camera.position.copy(target).add(offset);
  controls.update();
  controls.enableDamping = true;
  sceneDirty = true;
}

document.querySelector('#camera-top').addEventListener('click', () => {
  const distance = 1150 / Math.min(1, camera.aspect);
  setCamera(new THREE.Vector3(sectionCenter.x, sectionCenter.y, 0), new THREE.Vector3(0, -0.003, distance));
});
document.querySelector('#camera-side').addEventListener('click', () => {
  setLensZoom(0.6);
  const target = new THREE.Vector3(150, 0, 0);
  setCamera(target, new THREE.Vector3(670 / Math.min(1, camera.aspect), 0, 25));
});

document.querySelector('#wave-speed').textContent = CONFIG.speed;
const periods = [...new Set(sources.map(({ emissionPeriod }) => emissionPeriod))];
document.querySelector('#emission-period').textContent = periods.sort((a, b) => a - b).join(' / ');
document.querySelector('#max-radius').textContent = maxRadius;
document.querySelector('#section-span').textContent = sectionExtent * 2;
document.querySelector('#scale-label').textContent = `${CONFIG.scaleLength} m`;
const legend = document.querySelector('#section-legend');
for (const { label, colors } of sources) {
  const item = document.createElement('li');
  item.style.setProperty('--source-color', colors.section);
  item.textContent = label;
  legend.append(item);
}

function resize() {
  resizeScene(sceneCanvas.getBoundingClientRect());
  resizeSection(sectionCanvas.getBoundingClientRect());
}

const observer = new ResizeObserver(resize);
observer.observe(sceneCanvas);
observer.observe(sectionCanvas);
window.addEventListener('resize', resize);
resize();
const timeline = createTimeline(document.querySelector('#timeline'), { autoplay: false, startTime: 30 });
render(performance.now());
