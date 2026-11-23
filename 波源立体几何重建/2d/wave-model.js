import { CONFIG } from '../3d/wave-model.js';
import { createWaveField, SOURCES } from './wave-field.js';

export const sources = CONFIG.sources.map((source, index) => ({
  ...source,
  id: SOURCES[index].id,
  name: SOURCES[index].name,
  interval: source.emissionPeriod,
  speed: CONFIG.speed,
}));

export const { sectionCenter } = CONFIG;
export const field = createWaveField({ sources });
