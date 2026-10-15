export function watchVisibleRefresh(interval: number, refresh: (periodic: boolean) => void | Promise<unknown>) {
  let disposed = false;
  let paused = false;
  let pending = false;
  let lastStarted: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => !disposed && !paused && document.visibilityState === 'visible';
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stop();
    if (!visible() || pending) return;
    const remaining = lastStarted === null ? 0 : Math.max(0, interval - (Date.now() - lastStarted));
    if (remaining > 0) { timer = setTimeout(schedule, remaining); return; }
    const periodic = lastStarted !== null;
    lastStarted = Date.now();
    pending = true;
    void Promise.resolve().then(() => { if (visible()) return refresh(periodic); }).finally(() => {
      pending = false;
      schedule();
    });
  };
  const pause = () => { paused = true; stop(); };
  const resume = () => { paused = false; schedule(); };
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('hongsi-pause', pause);
  window.addEventListener('hongsi-resume', resume);
  schedule();
  return () => {
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('hongsi-pause', pause);
    window.removeEventListener('hongsi-resume', resume);
  };
}
