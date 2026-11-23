const END = 60;
const STEP = 0.05;

export function createTimeline(container, { autoplay = true, startTime = 0 } = {}) {
  container.classList.add('timeline');
  container.innerHTML = `
    <div class="timeline-controls" role="group" aria-label="模拟时间控制">
      <button id="playback" class="timeline-play" type="button"></button>
      <button id="reset" type="button" title="将模拟时间重置为 0">重置</button>
      <select id="speed" aria-label="播放倍速">
        <option value="0.5">0.5x</option><option value="1" selected>1x</option>
        <option value="2">2x</option><option value="5">5x</option><option value="10">10x</option>
      </select>
      <button id="step-back" type="button" aria-label="后退 0.1 秒">−0.1s</button>
      <button id="step-forward" type="button" aria-label="前进 0.1 秒">+0.1s</button>
      <label class="timeline-time">t <input id="time" type="number" min="0" max="${END}" step="0.01" value="0.00" aria-label="模拟时间（秒）"> s</label>
    </div>
    <div class="timeline-range">
      <span aria-hidden="true">0.00</span>
      <input id="timeline-slider" type="range" min="0" max="${END}" step="${STEP}" value="0" aria-label="模拟时间轴（秒）">
      <span aria-hidden="true">${END.toFixed(2)} s</span>
    </div>`;

  const playback = container.querySelector('#playback');
  const speedSelect = container.querySelector('#speed');
  const readout = container.querySelector('#time');
  const slider = container.querySelector('#timeline-slider');
  let playing = autoplay;
  let rate = 1;
  let anchorTime = startTime;
  let anchorReal = performance.now();

  function setPlaying(next) {
    playing = next;
    playback.textContent = playing ? '暂停' : '播放';
  }

  function paint(time) {
    const display = time.toFixed(2);
    if (document.activeElement !== readout && readout.value !== display) readout.value = display;
    const stepTime = (Math.round(time / STEP) * STEP).toFixed(2);
    if (slider.valueAsNumber !== Number(stepTime)) slider.value = stepTime;
  }

  function tick(now = performance.now()) {
    const time = Math.min(END, anchorTime + (playing ? Math.max(0, now - anchorReal) * rate / 1000 : 0));
    if (playing && time === END) {
      anchorTime = time;
      setPlaying(false);
    }
    paint(time);
    return time;
  }

  function seek(time) {
    anchorTime = Math.min(END, Math.max(0, Math.round(time * 100) / 100));
    anchorReal = performance.now();
    setPlaying(false);
    paint(anchorTime);
  }

  function pauseForScrub() {
    if (!playing) return;
    anchorTime = tick();
    setPlaying(false);
  }

  const nudge = amount => seek(tick() + amount);
  playback.addEventListener('click', () => {
    const next = !playing;
    anchorTime = tick();
    if (next && anchorTime === END) anchorTime = 0;
    anchorReal = performance.now();
    setPlaying(next);
  });
  container.querySelector('#reset').addEventListener('click', () => seek(0));
  speedSelect.addEventListener('change', () => {
    anchorTime = tick();
    anchorReal = performance.now();
    rate = Number(speedSelect.value);
  });
  slider.addEventListener('pointerdown', pauseForScrub);
  slider.addEventListener('input', () => seek(slider.valueAsNumber));
  readout.addEventListener('change', () => {
    if (Number.isFinite(readout.valueAsNumber)) seek(readout.valueAsNumber);
    readout.value = tick().toFixed(2);
  });
  readout.addEventListener('keydown', event => {
    if (event.key === 'Enter') readout.blur();
  });
  container.querySelector('#step-back').addEventListener('click', () => nudge(-0.1));
  container.querySelector('#step-forward').addEventListener('click', () => nudge(0.1));
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.target !== slider && event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    event.preventDefault();
    nudge((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 0.5 : STEP));
  }, { capture: true });

  setPlaying(playing);
  return { tick };
}
