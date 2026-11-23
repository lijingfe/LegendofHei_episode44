import { createTimeline } from '../3d/timeline.js?v=f81fbff';
import { mountWaveView } from './app.js?v=f81fbff';
import { field, sectionCenter, sources } from './wave-model.js';

document.querySelector('#wave-speed').textContent = `${sources[0].speed} m/s`;
document.querySelector('#wave-interval').textContent = `${sources[0].interval} s`;

const timeline = createTimeline(document.querySelector('#timeline'), { autoplay: false, startTime: 15 });
const view = mountWaveView({ field, sectionCenter, sources });

function frame(now) {
  view.render(timeline.tick(now));
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
