const waveColors = {
  shell: '#020710', rim: '#285f8f', grid: '#1c5f94', gridRim: '#63c7ff',
  intersection: '#9be6ff', innerEdge: '#3b8ac6', innerCenter: '#7cc8ff',
  core: '#85bcff', section: '#7ddcff',
};

export const CONFIG = {
  speed: 10,
  maxRadius: 600,
  fadeStartFraction: 0.7,
  sources: [
    {
      id: 'source-1', label: '1号', x: 488.5, y: 318.0, z: 39.0, startTime: 11.76, emissionPeriod: 10,
      colors: waveColors,
    },
    {
      id: 'source-2', label: '2号', x: 200.9, y: 226.3, z: -81.1, startTime: 5.65, emissionPeriod: 10,
      colors: waveColors,
    },
    {
      id: 'origin', label: '3号·原点', x: 0.0, y: 0.0, z: 0.0, startTime: 0.0, emissionPeriod: 10,
      colors: waveColors,
    },
    {
      id: 'source-4', label: '4号', x: 169.0, y: -251.1, z: 84.1, startTime: 5.83, emissionPeriod: 10,
      colors: waveColors,
    },
    {
      id: 'source-5', label: '5号', x: 470.6, y: -287.5, z: -13.3, startTime: 15.39, emissionPeriod: 10,
      colors: waveColors,
    },
  ],
  sectionCenter: { x: 220, y: 0 },
  sectionExtent: 580,
  scaleLength: 100,
  colors: {
    background: '#02060d',
    grid: '#377d9e',
    axes: '#4d9fbd',
    sectionBackground: '#071120',
    sectionGrid: 'rgba(100, 204, 231, 0.10)',
    sectionAxes: 'rgba(127, 218, 243, 0.31)',
    sectionLabels: '#97c6d8',
  },
};

export function waveCapacity(source) {
  return Math.floor(CONFIG.maxRadius / (CONFIG.speed * source.emissionPeriod)) + 1;
}

export function latestEmission(time, source) {
  return Math.floor((time - source.startTime) / source.emissionPeriod);
}

export function waveRadius(time, emission, source) {
  if (emission < 0) return null;
  const emittedAt = source.startTime + emission * source.emissionPeriod;
  return time >= emittedAt ? CONFIG.speed * (time - emittedAt) : null;
}

export function waveOpacity(radius) {
  const fadeStart = CONFIG.maxRadius * CONFIG.fadeStartFraction;
  const progress = Math.max(0, Math.min(1, (radius - fadeStart) / (CONFIG.maxRadius - fadeStart)));
  return 1 - progress * progress * (3 - 2 * progress);
}

export function sectionRadius(radius, sourceZ) {
  // The radius computed at tangency can round slightly below the source height.
  if (radius < Math.abs(sourceZ) - 1e-9) return null;
  return Math.sqrt(Math.max(0, radius * radius - sourceZ * sourceZ));
}
