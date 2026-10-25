import type { Coordinate } from './campus-data';

type MapView = { x: number; y: number; k: number; angle: number };
export const mapView = (): MapView => ({ x: 0, y: 0, k: 1, angle: 0 });
export const angleDifference = (a: number, b: number) => ((b - a + 540) % 360 + 360) % 360 - 180;

export function applyView(view: MapView, point: Coordinate): Coordinate {
  const angle = view.angle * Math.PI / 180, c = Math.cos(angle) * view.k, s = Math.sin(angle) * view.k;
  return [view.x + c * point[0] - s * point[1], view.y + s * point[0] + c * point[1]];
}

export function invertView(view: MapView, point: Coordinate): Coordinate {
  const angle = view.angle * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const x = (point[0] - view.x) / view.k, y = (point[1] - view.y) / view.k;
  return [c * x + s * y, -s * x + c * y];
}

function anchoredView(point: Coordinate, target: Coordinate, k: number, angle: number): MapView {
  const view = { x: 0, y: 0, k: Math.max(1, Math.min(10, k)), angle };
  const offset = applyView(view, point);
  return { ...view, x: target[0] - offset[0], y: target[1] - offset[1] };
}

export function viewMatrix(view: MapView) {
  const angle = view.angle * Math.PI / 180, c = Math.cos(angle) * view.k, s = Math.sin(angle) * view.k;
  return `matrix(${c},${s},${-s},${c},${view.x},${view.y})`;
}

export function createMapCamera(stage: HTMLElement, changed: (view: MapView, moving: boolean) => void, interacted: () => void) {
  let view = mapView(), width = 0, height = 0, frame = 0, wheelTimer: ReturnType<typeof setTimeout> | undefined;
  let animation: { from: MapView; to: MapView; at: number; duration: number } | null = null;
  const points = new Map<number, Coordinate>();
  let gesture: { view: MapView; center: Coordinate; distance: number; angle: number; rotate: boolean } | null = null;
  let dragging = false, suppressUntil = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const middle = (): Coordinate => [width / 2, height / 2];
  const center = (value = view) => invertView(value, middle());
  const notify = (moving: boolean) => changed(view, moving);
  const local = (event: PointerEvent | WheelEvent): Coordinate => {
    const rect = stage.getBoundingClientRect();
    return [event.clientX - rect.left - stage.clientLeft, event.clientY - rect.top - stage.clientTop];
  };
  function stopAnimation() { cancelAnimationFrame(frame); frame = 0; animation = null; }
  function constrain(next: MapView) {
    const p = center(next);
    return anchoredView([Math.max(-width / 4, Math.min(width * 1.25, p[0])), Math.max(-height / 4, Math.min(height * 1.25, p[1]))], middle(), next.k, next.angle);
  }
  function animate(at: number) {
    frame = 0;
    if (!animation) return;
    const { from, to, duration } = animation;
    const t = Math.min(1, (at - animation.at) / duration), f = 1 - (1 - t) ** 3;
    const a = center(from), b = center(to);
    view = anchoredView([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], middle(), from.k + (to.k - from.k) * f, from.angle + (to.angle - from.angle) * f);
    if (t === 1) { animation = null; notify(false); }
    else { notify(true); frame = requestAnimationFrame(animate); }
  }
  function move(next: MapView, duration = 200) {
    stopAnimation();
    next = { ...next, angle: view.angle + angleDifference(view.angle, next.angle) };
    if (!duration || reducedMotion.matches) { view = next; notify(false); return; }
    animation = { from: view, to: next, at: performance.now(), duration };
    notify(true); frame = requestAnimationFrame(animate);
  }
  function baseline(rotate = false) {
    const [a, b] = [...points.values()];
    if (!a) { gesture = null; return; }
    gesture = { view, center: b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a,
      distance: b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0,
      angle: b ? Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI : 0, rotate };
  }
  function down(event: PointerEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('button:not(.building-button)') || (event.pointerType === 'mouse' && ![0, 2].includes(event.button))) return;
    if (!target.closest('button')) stage.focus({ preventScroll: true });
    stopAnimation(); clearTimeout(wheelTimer);
    points.set(event.pointerId, local(event));
    baseline(event.button === 2 || event.shiftKey || event.altKey);
    window.addEventListener('pointermove', drag, { passive: false });
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function drag(event: PointerEvent) {
    if (!points.has(event.pointerId) || !gesture) return;
    points.set(event.pointerId, local(event));
    const [a, b] = [...points.values()];
    const target: Coordinate = b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a;
    const dx = target[0] - gesture.center[0], dy = target[1] - gesture.center[1];
    if (!dragging && !b && Math.hypot(dx, dy) < 4) return;
    if (!dragging) { dragging = true; interacted(); }
    if (event.cancelable) event.preventDefault();
    const k = b && gesture.distance > 1 ? gesture.view.k * Math.hypot(b[0] - a[0], b[1] - a[1]) / gesture.distance : gesture.view.k;
    const angle = b ? gesture.view.angle + angleDifference(gesture.angle, Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI)
      : gesture.rotate ? gesture.view.angle + dx * .4 : gesture.view.angle;
    const anchor = gesture.rotate && !b ? middle() : gesture.center;
    view = constrain(anchoredView(invertView(gesture.view, anchor), gesture.rotate && !b ? middle() : target, k, angle));
    notify(true);
  }
  function up(event: PointerEvent) {
    if (!points.delete(event.pointerId)) return;
    if (points.size) { baseline(); return; }
    if (dragging) suppressUntil = performance.now() + 350;
    dragging = false; gesture = null; notify(false);
    window.removeEventListener('pointermove', drag); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
  }
  function click(event: MouseEvent) {
    if (performance.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  function wheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
    event.preventDefault(); stopAnimation(); interacted();
    const target = local(event), p = invertView(view, target);
    view = constrain(anchoredView(p, target, event.altKey ? view.k : view.k * Math.exp(-event.deltaY * .005), view.angle + (event.altKey ? event.deltaY * .15 : 0)));
    notify(true); clearTimeout(wheelTimer); wheelTimer = setTimeout(() => notify(false), 100);
  }
  function contextMenu(event: MouseEvent) { event.preventDefault(); }
  function key(event: KeyboardEvent) {
    const directions: Record<string, Coordinate> = { ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, -40], ArrowDown: [0, 40] };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault(); interacted();
      if (event.shiftKey) move(anchoredView(center(), middle(), view.k, view.angle + (direction[0] || direction[1]) * .375));
      else move(constrain({ ...view, x: view.x - direction[0], y: view.y - direction[1] }));
    } else if (['+', '=', '-', 'n', 'N'].includes(event.key)) {
      event.preventDefault();
      if (event.key.toLowerCase() === 'n') interacted();
      move(anchoredView(center(), middle(), view.k * (event.key === '-' ? 1 / 1.4 : event.key === '+' || event.key === '=' ? 1.4 : 1), event.key.toLowerCase() === 'n' ? 0 : view.angle));
    }
  }
  stage.addEventListener('pointerdown', down);
  stage.addEventListener('wheel', wheel, { passive: false });
  stage.addEventListener('click', click, true);
  stage.addEventListener('contextmenu', contextMenu);
  stage.addEventListener('keydown', key);
  return {
    resize(w: number, h: number, point?: Coordinate) {
      stopAnimation(); width = w; height = h;
      view = point ? anchoredView(point, middle(), view.k, view.angle) : mapView(); notify(false);
    },
    center,
    scale: () => animation?.to.k ?? view.k,
    move(point: Coordinate, k = view.k, angle = view.angle, duration = 200) { move(anchoredView(point, middle(), k, angle), duration); },
    zoom(factor: number) { move(anchoredView(center(), middle(), (animation?.to.k ?? view.k) * factor, view.angle)); },
    north() { move(anchoredView(center(), middle(), view.k, 0)); },
    destroy() {
      stopAnimation(); clearTimeout(wheelTimer); points.clear();
      stage.removeEventListener('pointerdown', down); stage.removeEventListener('wheel', wheel);
      stage.removeEventListener('click', click, true); stage.removeEventListener('contextmenu', contextMenu);
      stage.removeEventListener('keydown', key);
      window.removeEventListener('pointermove', drag); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    },
  };
}
