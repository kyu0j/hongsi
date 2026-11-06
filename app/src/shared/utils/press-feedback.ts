export function watchPressFeedback() {
  const controller = new AbortController();
  const options = { signal: controller.signal, capture: true };
  const root = document.documentElement;
  const previous = root.getAttribute('data-input');
  root.dataset.input = matchMedia('(hover: hover) and (pointer: fine)').matches ? 'mouse' : 'touch';
  let pressed: HTMLElement | null = null;
  let pointer: number | null = null;

  function clear() {
    pressed?.removeAttribute('data-pressed');
    pressed = null;
    pointer = null;
  }

  function control(target: EventTarget | null) {
    const node = target instanceof Element ? target.closest<HTMLElement>('button, a[href], summary') : null;
    return node && !node.matches(':disabled, [aria-disabled="true"]') && !node.closest('[inert]') ? node : null;
  }

  function source(event: PointerEvent) {
    if (!event.pointerType) return;
    const input = event.pointerType === 'mouse' ? 'mouse' : 'touch';
    if (root.dataset.input !== input) root.dataset.input = input;
  }

  function end(event: PointerEvent) {
    if (event.pointerId === pointer) clear();
  }

  document.addEventListener('pointerover', source, options);
  document.addEventListener('pointermove', source, options);
  document.addEventListener('pointerdown', (event) => {
    source(event);
    if (!event.isPrimary || event.button !== 0) return;
    clear();
    pressed = control(event.target);
    if (!pressed) return;
    pointer = event.pointerId;
    pressed.setAttribute('data-pressed', '');
  }, options);
  document.addEventListener('pointerout', (event) => {
    if (event.pointerId === pointer && !(event.relatedTarget instanceof Node && pressed?.contains(event.relatedTarget))) clear();
  }, options);
  document.addEventListener('lostpointercapture', end, options);
  document.addEventListener('keydown', (event) => {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
    clear();
    pressed = control(event.target);
    pressed?.setAttribute('data-pressed', '');
  }, options);
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Enter' || event.key === ' ') clear();
  }, options);
  document.addEventListener('focusout', (event) => {
    if (pressed?.contains(event.target as Node)) clear();
  }, options);
  window.addEventListener('pointerup', end, options);
  window.addEventListener('pointercancel', end, options);
  window.addEventListener('blur', clear, options);
  window.addEventListener('hongsi-pause', clear, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); }, options);

  return () => {
    controller.abort();
    clear();
    if (previous === null) root.removeAttribute('data-input');
    else root.setAttribute('data-input', previous);
  };
}
