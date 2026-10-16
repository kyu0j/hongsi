export function pressFeedback(node: HTMLButtonElement) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let pointer: number | null = null;

  function clear() {
    pointer = null;
    node.removeAttribute('data-pressed');
  }

  function begin(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || node.disabled) return;
    pointer = event.pointerId;
    node.setAttribute('data-pressed', '');
  }

  function end(event: PointerEvent) {
    if (event.pointerId === pointer) clear();
  }

  node.addEventListener('pointerdown', begin, options);
  node.addEventListener('pointerleave', end, options);
  node.addEventListener('lostpointercapture', end, options);
  node.addEventListener('blur', clear, options);
  node.addEventListener('keydown', (event) => {
    if (!node.disabled && (event.key === 'Enter' || event.key === ' ')) node.setAttribute('data-pressed', '');
  }, options);
  node.addEventListener('keyup', (event) => {
    if (event.key === 'Enter' || event.key === ' ') clear();
  }, options);
  window.addEventListener('pointerup', end, { ...options, capture: true });
  window.addEventListener('pointercancel', end, { ...options, capture: true });
  window.addEventListener('blur', clear, options);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); }, options);

  return { destroy() { controller.abort(); clear(); } };
}
