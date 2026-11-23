import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG, latestEmission, waveCapacity, waveRadius, waveOpacity, sectionRadius } from './wave-model.js';
import { createTimeline } from './timeline.js?v=f81fbff';
import { BASE_FOV } from './lens.js';

const { colors, sources, maxRadius, sectionCenter, sectionExtent } = CONFIG;
const sceneCanvas = document.querySelector('#scene');
const sectionCanvas = document.querySelector('#section');
const scaleBar = document.querySelector('#scale-bar');

const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: false, powerPreference: 'low-power' });
const scene = new THREE.Scene();
scene.background = new THREE.Color(colors.background);
const sourcePositions = sources.map(({ x, y, z }) => new THREE.Vector3(x, y, z));
const startTime = 15;
const sceneRadius = maxRadius + Math.max(...sourcePositions.map(position => position.length()));
const initialRadius = Math.max(...sources.map((source, index) => (
  sourcePositions[index].length() + (waveRadius(startTime, 0, source) ?? 0)
)));
const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 1, sceneRadius * 14);
camera.up.set(0, 0, 1);
// Preserve +X to the right at OrbitControls' polar limit.
camera.position.set(0, -0.003, sceneRadius * 3);

const controls = new OrbitControls(camera, sceneCanvas);
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
grid.position.set(sectionCenter.x, sectionCenter.y, 0);
grid.renderOrder = 0;
scene.add(grid);

const shellGeometry = new THREE.SphereGeometry(1, 64, 40).rotateX(Math.PI / 2);
const shellMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  forceSinglePass: true,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uSource: { value: new THREE.Vector3() },
    uShell: { value: new THREE.Color() },
    uRim: { value: new THREE.Color() },
    uIntersection: { value: new THREE.Color() },
    uOpacity: { value: 0 },
    uIntersects: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    varying vec2 vGrid;

    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      vGrid = uv * vec2(24.0, 12.0);
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSource;
    uniform vec3 uShell;
    uniform vec3 uRim;
    uniform vec3 uIntersection;
    uniform float uOpacity;
    uniform float uIntersects;
    varying vec3 vWorldPos;
    varying vec2 vGrid;

    float gridLine(float coordinate, float footprint) {
      float nearest = abs(fract(coordinate + 0.5) - 0.5);
      float width = max(footprint, 0.001);
      return (1.0 - smoothstep(0.05 * width, 1.15 * width, nearest))
        * (1.0 - smoothstep(0.28, 0.55, width));
    }

    void main() {
      vec3 normal = normalize(vWorldPos - uSource);
      vec3 view = normalize(cameraPosition - vWorldPos);
      float grazing = 1.0 - abs(dot(normal, view));
      float fresnel = grazing * grazing * grazing;
      vec2 footprint = fwidth(vGrid);
      float poleDistance = min(vGrid.y, 12.0 - vGrid.y);
      float meridians = gridLine(vGrid.x, footprint.x) * smoothstep(0.2, 0.7, poleDistance);
      float parallels = gridLine(vGrid.y, footprint.y);
      float surfaceGrid = max(meridians, parallels);

      float height = abs(vWorldPos.z);
      float pixel = max(fwidth(vWorldPos.z), 0.05);
      float ring = (1.0 - smoothstep(0.25 * pixel, 1.15 * pixel + 0.85, height)) * uIntersects;
      float glow = (1.0 - smoothstep(0.0, 2.2 * pixel + 3.0, height)) * uIntersects;

      vec3 tint = mix(uShell, uRim, fresnel);
      tint = mix(tint, uIntersection, max(ring, glow * 0.38));
      float body = 0.003 + 0.18 * fresnel + (0.026 + 0.028 * grazing) * surfaceGrid;
      gl_FragColor = vec4(tint, uOpacity * (body + 0.48 * ring + 0.12 * glow));
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

const sourceViews = sources.map((source, index) => {
  const position = sourcePositions[index];
  const coreMaterial = new THREE.SpriteMaterial({
    map: coreTexture, color: source.colors.core, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const core = new THREE.Sprite(coreMaterial);
  core.position.copy(position);
  core.scale.set(44, 44, 1);
  core.renderOrder = 2;
  scene.add(core);

  if (source.z !== 0) {
    const projectionMaterial = coreMaterial.clone();
    projectionMaterial.color.set(source.colors.section);
    projectionMaterial.opacity = 0.4;
    const projection = new THREE.Sprite(projectionMaterial);
    projection.position.set(source.x, source.y, 0);
    projection.scale.set(32, 32, 1);
    projection.renderOrder = 2;
    const heightMaterial = new THREE.LineDashedMaterial({
      color: source.colors.section, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const height = new THREE.Line(new THREE.BufferGeometry().setFromPoints([position, projection.position]), heightMaterial);
    height.computeLineDistances();
    scene.add(height, projection);
  }

  // Each source recycles its own slots at its configured emission interval.
  const waves = Array.from({ length: waveCapacity(source) }, () => {
    const material = shellMaterial.clone();
    material.uniforms.uSource.value.copy(position);
    material.uniforms.uShell.value.set(source.colors.shell);
    material.uniforms.uRim.value.set(source.colors.rim);
    material.uniforms.uIntersection.value.set(source.colors.intersection);
    const mesh = new THREE.Mesh(shellGeometry, material);
    mesh.position.copy(position);
    mesh.renderOrder = 1;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, opacity: 0, section: null };
  });
  return { source, waves, sectionActive: false };
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
  if (camera.view === null) {
    const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const frameWidth = (width - 2 * offsetX) / height;
    const frameHeight = (height - 2 * offsetY) / height;
    const frameHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.min(frameWidth, frameHeight));
    const fitDistance = initialRadius * 1.04 / Math.sin(frameHalfFov);
    camera.position.set(0, -0.003, fitDistance);
    controls.update();
  }
  // Bound transparent fragment work on high-DPI and large monitors.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5, Math.sqrt(1_250_000 / (width * height))));
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
  for (const view of sourceViews) {
    const { source, waves } = view;
    const latest = latestEmission(time, source);
    view.sectionActive = false;
    for (let i = 0; i < waves.length; i++) {
      const wave = waves[i];
      const radius = waveRadius(time, latest - i, source);
      wave.opacity = radius === null ? 0 : waveOpacity(radius);
      wave.section = wave.opacity > 0 ? sectionRadius(radius, source.z) : null;
      view.sectionActive ||= wave.section !== null;
      wave.mesh.visible = radius > 0 && wave.opacity > 0;
      if (wave.mesh.visible) {
        wave.mesh.scale.setScalar(radius);
        wave.mesh.material.uniforms.uOpacity.value = wave.opacity;
        wave.mesh.material.uniforms.uIntersects.value = Number(wave.section !== null);
      }
    }
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

document.querySelector('#wave-speed').textContent = CONFIG.speed;
const periods = [...new Set(sources.map(({ emissionPeriod }) => emissionPeriod))];
document.querySelector('#emission-period').textContent = periods.sort((a, b) => a - b).join(' / ');
document.querySelector('#max-radius').textContent = maxRadius;
document.querySelector('#section-span').textContent = sectionExtent * 2;
document.querySelector('#scale-label').textContent = `${CONFIG.scaleLength} m`;
const legend = document.querySelector('#section-legend');
const coordinates = document.querySelector('#source-coordinates');
for (const { label, colors, x, y, z, startTime } of sources) {
  const item = document.createElement('li');
  item.style.setProperty('--source-color', colors.section);
  item.textContent = label;
  legend.append(item);

  const coordinate = item.cloneNode();
  const values = document.createElement('span');
  values.textContent = `${label} (${x}, ${y}, ${z})`;
  const emission = document.createElement('span');
  emission.textContent = `t=${startTime.toFixed(2)} s`;
  coordinate.append(values, emission);
  coordinates.append(coordinate);
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
const timeline = createTimeline(document.querySelector('#timeline'), { autoplay: false, startTime });
render(performance.now());
