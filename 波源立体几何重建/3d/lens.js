export const BASE_FOV = 42;

export function mountLens(label, camera, onChange) {
  const select = document.createElement('select');
  select.id = 'lens-zoom';
  select.setAttribute('aria-label', '镜头广角倍率');
  for (const zoom of [0.5, 0.6, 0.8, 1]) select.add(new Option(`${zoom}x`, zoom));
  select.value = '1';
  label.append(select);

  const baseHalfAngle = BASE_FOV * Math.PI / 360;
  function setZoom(zoom) {
    select.value = String(zoom);
    camera.fov = 2 * Math.atan(Math.tan(baseHalfAngle) / zoom) * (180 / Math.PI);
    camera.updateProjectionMatrix();
    onChange();
  }

  select.addEventListener('change', () => setZoom(Number(select.value)));
  return setZoom;
}
