const PALETTES = {
  teaching: {
    background: '#071120', minor: '#13253a', grid: '#244058', axis: '#54849e',
    text: '#b6cada', outline: '#071120', cursor: '#c8f2ff', warning: '#ff7b8e',
  },
  animation: {
    background: '#389ed1', minor: '#ffffff20', grid: '#ffffff60', axis: '#ffffffb5',
    text: '#f7fbff', outline: '#226087', wave: '#fffdf3', cursor: '#fffdf3', warning: '#a31834',
  },
};

function coordinates({ x, y }) {
  return `${x.toFixed(1)}, ${y.toFixed(1)}`.replaceAll('-', '−');
}

function sourceCoordinates({ x, y, z }) {
  return `(${x}, ${y}, ${z})`;
}

export function mountWaveView({ field, sectionCenter, sources }) {
  const canvas = document.querySelector('#field');
  const ctx = canvas.getContext('2d', { alpha: false });
  const scaleBar = document.querySelector('#scale-bar');
  const scaleLength = document.querySelector('#scale-length');
  const probe = document.querySelector('#probe');
  const probeState = document.querySelector('#probe-state');
  const probePoint = document.querySelector('#probe-point');
  const probeDistance = document.querySelector('#probe-distance');
  const sourcePanel = document.querySelector('#sources');
  const visible = new Set(sources.map(({ id }) => id));
  const sourceColors = new Map(sources.map(({ id, colors }) => [id, colors.section]));
  const modeButtons = document.querySelectorAll('[data-mode]');
  let palette = PALETTES.teaching;
  let width = 0;
  let height = 0;
  let leftInset = 0;
  let centerX = 0;
  let camera;
  let pointer = null;
  let drag = null;
  let dirty = true;
  let lastTime = NaN;

  for (const source of sources) {
    const row = document.createElement('label');
    row.className = 'source';
    row.style.setProperty('--source-color', source.colors.section);
    row.innerHTML = '<input type="checkbox" checked><span></span>';
    row.querySelector('span').textContent = `${source.label} ${sourceCoordinates(source)}`;
    row.querySelector('input').addEventListener('change', ({ target }) => {
      if (target.checked) visible.add(source.id);
      else visible.delete(source.id);
      dirty = true;
    });
    sourcePanel.append(row);
  }

  function resetView() {
    camera = { ...sectionCenter, scale: Math.min((width - leftInset) / 1040, height / 830) };
    dirty = true;
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    width = bounds.width;
    height = bounds.height;
    const panel = sourcePanel.parentElement;
    leftInset = getComputedStyle(panel).position === 'absolute' ? panel.offsetWidth + 2 * panel.offsetLeft : 0;
    centerX = (width + leftInset) / 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    if (!camera) resetView();
    dirty = true;
  }

  const screenX = x => centerX + (x - camera.x) * camera.scale;
  const screenY = y => height / 2 - (y - camera.y) * camera.scale;
  const worldAt = ({ x, y }) => ({ x: camera.x + (x - centerX) / camera.scale, y: camera.y + (height / 2 - y) / camera.scale });

  function drawGrid() {
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, width, height);
    const bottomLeft = worldAt({ x: 0, y: height });
    const topRight = worldAt({ x: width, y: 0 });
    let major = 100;
    while (major * camera.scale < 33) major *= 2;

    function grid(spacing, color) {
      ctx.beginPath();
      for (let x = Math.ceil(bottomLeft.x / spacing) * spacing; x <= topRight.x; x += spacing) {
        ctx.moveTo(screenX(x), 0);
        ctx.lineTo(screenX(x), height);
      }
      for (let y = Math.ceil(bottomLeft.y / spacing) * spacing; y <= topRight.y; y += spacing) {
        ctx.moveTo(0, screenY(y));
        ctx.lineTo(width, screenY(y));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (25 * camera.scale >= 9) grid(25, palette.minor);
    grid(major, palette.grid);
    const x0 = screenX(0);
    const y0 = screenY(0);
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, height);
    ctx.moveTo(0, y0);
    ctx.lineTo(width, y0);
    ctx.strokeStyle = palette.axis;
    ctx.stroke();
    ctx.font = '11px monospace';
    ctx.fillStyle = palette.text;
    ctx.textAlign = 'left';
    if (x0 >= 0 && x0 <= width) ctx.fillText('Y', Math.min(width - 12, x0 + 7), 16);
    if (y0 >= 0 && y0 <= height) ctx.fillText('X', width - 14, Math.max(15, y0 - 7));

    const target = 80 / camera.scale;
    const unit = 10 ** Math.floor(Math.log10(target));
    const meters = [5, 2, 1].find(value => value * unit <= target) * unit;
    const scaleWidth = `${meters * camera.scale}px`;
    const scaleLabel = `${meters} m`;
    if (scaleBar.style.width !== scaleWidth) scaleBar.style.width = scaleWidth;
    if (scaleLength.textContent !== scaleLabel) scaleLength.textContent = scaleLabel;
  }

  function drawCircles(time) {
    for (const circle of field.getActiveCircles(time)) {
      if (!visible.has(circle.sourceId)) continue;
      const fresh = circle.R3D - Math.abs(circle.z) < 9;
      ctx.beginPath();
      ctx.arc(screenX(circle.cx), screenY(circle.cy), Math.max(1, circle.r * camera.scale), 0, 2 * Math.PI);
      ctx.strokeStyle = palette.wave ?? sourceColors.get(circle.sourceId);
      ctx.globalAlpha = fresh ? .26 : .15;
      ctx.lineWidth = fresh ? 4.5 : 3.5;
      ctx.stroke();
      ctx.globalAlpha = fresh ? 1 : .86;
      ctx.lineWidth = fresh ? 1.6 : 1.15;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawSources() {
    for (const source of sources) {
      if (!visible.has(source.id)) continue;
      const x = screenX(source.x);
      const y = screenY(source.y);
      const preferLeftOfPoint = width < 500 && source.y < sectionCenter.y && x >= 135;
      const alignLeft = !preferLeftOfPoint && x < width - 125;
      const labelX = x + (alignLeft ? 9 : -9);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = palette.wave ?? source.colors.section;
      ctx.fill();
      ctx.textAlign = alignLeft ? 'left' : 'right';
      ctx.font = '600 12px system-ui';
      ctx.strokeStyle = palette.outline;
      ctx.lineWidth = 3;
      ctx.strokeText(source.label, labelX, y - 5);
      ctx.fillText(source.label, labelX, y - 5);
      ctx.font = `${width < 500 ? 9 : 10}px monospace`;
      const detail = sourceCoordinates(source);
      ctx.strokeText(detail, labelX, y + 9);
      ctx.fillText(detail, labelX, y + 9);
    }
  }

  function drawProbe(time) {
    if (!pointer) {
      probe.classList.remove('is-collision');
      if (probeState.textContent !== '指向画布') {
        probeState.textContent = '指向画布';
        probePoint.textContent = probeDistance.textContent = '—';
      }
      return;
    }
    const { x, y } = worldAt(pointer);
    const { distance } = field.distanceToNearestWave(x, y, time);
    const collision = field.isColliding(x, y, time);
    probe.classList.toggle('is-collision', collision);
    const state = collision ? '碰撞警戒' : '未触碰';
    if (probeState.textContent !== state) probeState.textContent = state;
    probePoint.textContent = `(${coordinates({ x, y })})`;
    probeDistance.textContent = Number.isFinite(distance) ? `${distance.toFixed(2)} m` : '—';
    ctx.beginPath();
    ctx.arc(pointer.x, pointer.y, 5, 0, 2 * Math.PI);
    ctx.strokeStyle = collision ? palette.warning : palette.cursor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    pointer = position(event);
    drag = { ...pointer, id: event.pointerId };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
    dirty = true;
  });
  canvas.addEventListener('pointermove', event => {
    if (!event.isPrimary) return;
    pointer = position(event);
    if (drag?.id === event.pointerId) {
      camera.x -= (pointer.x - drag.x) / camera.scale;
      camera.y += (pointer.y - drag.y) / camera.scale;
      drag = { ...pointer, id: event.pointerId };
    }
    dirty = true;
  });
  canvas.addEventListener('lostpointercapture', () => {
    drag = null;
    canvas.classList.remove('is-dragging');
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    dirty = true;
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    pointer = position(event);
    const before = worldAt(pointer);
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    camera.scale = Math.max(.025, Math.min(16, camera.scale * Math.exp(-event.deltaY * multiplier * .0015)));
    const after = worldAt(pointer);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    dirty = true;
  }, { passive: false });

  document.querySelector('#view-reset').addEventListener('click', resetView);
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      palette = PALETTES[button.dataset.mode];
      for (const mode of modeButtons) mode.setAttribute('aria-pressed', String(mode === button));
      dirty = true;
    });
  }
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();

  return {
    render(time) {
      if (!camera || (!dirty && time === lastTime)) return;
      drawGrid();
      drawCircles(time);
      drawSources();
      drawProbe(time);
      dirty = false;
      lastTime = time;
    },
  };
}
