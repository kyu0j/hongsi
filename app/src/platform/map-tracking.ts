import { Channel, invoke } from '@tauri-apps/api/core';
import type { LocationFix } from '../features/campus-map/location-filter';

type MapSensorEvent = { type: 'position'; position: LocationFix }
  | { type: 'heading'; heading: number; accuracy: number }
  | { type: 'error'; message: string };
let nativeQueue: Promise<unknown> = Promise.resolve();
let nativeEvents: Channel<MapSensorEvent> | undefined;
let nativeReceive: ((event: MapSensorEvent) => void) | null = null;
let nativeConnected = false;

function nativeCommand(action: string) {
  nativeEvents ??= new Channel<MapSensorEvent>((event) => nativeReceive?.(event));
  const events = nativeEvents;
  const result = nativeQueue.then(async () => {
    if (!nativeConnected) { await invoke('map_tracking_channel', { events }); nativeConnected = true; }
    return invoke<{ headingAvailable?: boolean }>('map_tracking', { action, events });
  });
  nativeQueue = result.catch(() => {});
  return result;
}

export function createMapTracking(receive: (event: MapSensorEvent) => void) {
  let running = false, generation = 0;
  let receiveNative: ((event: MapSensorEvent) => void) | null = null;
  const emit = (event: MapSensorEvent) => { if (running && !document.hidden) receive(event); };
  return {
    async start() {
      if (running) return;
      running = true;
      const current = ++generation;
      try {
        receiveNative = (event) => { if (current === generation) emit(event); };
        nativeReceive = receiveNative;
        await nativeCommand('start');
      } catch (error) { if (current === generation) running = false; throw error; }
    },
    async heading(enabled: boolean) {
      if (!running) return !enabled;
      return !!(await nativeCommand(enabled ? 'heading-on' : 'heading-off')).headingAvailable;
    },
    stop() {
      if (!running) return;
      running = false; generation++;
      if (nativeReceive === receiveNative) nativeReceive = null;
      void nativeCommand('stop').catch(() => {});
    },
  };
}
