export interface PwaUpdateRuntime {
  getController: () => ServiceWorker | null;
  onControllerChange: (listener: () => void) => () => void;
  getRegistration: () => Promise<ServiceWorkerRegistration | null | undefined>;
  isVisible: () => boolean;
  isOnline: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  reload: () => void;
  now: () => number;
  minUpdateCheckIntervalMs?: number;
}

export interface PwaUpdateSnapshot {
  updateAvailable: boolean;
  manualReloadBlocked: boolean;
}

export interface PwaUpdateManager {
  start: () => () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PwaUpdateSnapshot;
  registerReloadGuard: (guard: () => boolean) => () => void;
  registerManualReloadGuard: (guard: () => boolean) => () => void;
  refreshGuardState: () => void;
  reloadToApplyUpdate: () => void;
}

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60_000;
const EMPTY_UPDATE_SNAPSHOT: PwaUpdateSnapshot = {
  updateAvailable: false,
  manualReloadBlocked: false,
};

export function createPwaUpdateManager(runtime: PwaUpdateRuntime): PwaUpdateManager {
  const listeners = new Set<() => void>();
  const reloadGuards = new Set<() => boolean>();
  const manualReloadGuards = new Set<() => boolean>();
  let snapshot: PwaUpdateSnapshot = { updateAvailable: false, manualReloadBlocked: false };
  let reloadIssued = false;
  let running = false;
  let startCount = 0;
  let lifecycleGeneration = 0;
  let removeListeners: (() => void) | undefined;
  let currentController = runtime.getController();
  let hasBeenControlled = currentController !== null;
  let updateCheckInFlight = false;
  let lastUpdateCheckAt = Number.NEGATIVE_INFINITY;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const hasReloadGuard = () => {
    for (const guard of reloadGuards) {
      try {
        if (guard()) return true;
      } catch {
        // A failing guard must keep the current document open rather than discard input.
        return true;
      }
    }
    return false;
  };

  const hasManualReloadGuard = () => {
    for (const guard of manualReloadGuards) {
      try {
        if (guard()) return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  const refreshGuardState = () => {
    const manualReloadBlocked = hasManualReloadGuard();
    if (snapshot.manualReloadBlocked !== manualReloadBlocked) {
      snapshot = { ...snapshot, manualReloadBlocked };
      notify();
    }
  };

  const markUpdateAvailable = () => {
    if (!snapshot.updateAvailable) {
      snapshot = { ...snapshot, updateAvailable: true };
      notify();
    }
    refreshGuardState();
  };

  const onControllerChange = () => {
    const nextController = runtime.getController();
    if (!nextController || nextController === currentController) return;

    currentController = nextController;
    if (!hasBeenControlled) {
      hasBeenControlled = true;
      return;
    }

    if (reloadIssued) return;
    if (snapshot.updateAvailable || hasReloadGuard()) {
      markUpdateAvailable();
      return;
    }

    reloadIssued = true;
    runtime.reload();
  };

  const checkForUpdate = async () => {
    if (!running || !runtime.isVisible() || !runtime.isOnline() || updateCheckInFlight) return;
    const now = runtime.now();
    const interval = runtime.minUpdateCheckIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
    if (now - lastUpdateCheckAt < interval) return;

    updateCheckInFlight = true;
    lastUpdateCheckAt = now;
    const checkGeneration = lifecycleGeneration;
    try {
      const registration = await runtime.getRegistration();
      if (
        running &&
        checkGeneration === lifecycleGeneration &&
        registration &&
        runtime.isVisible() &&
        runtime.isOnline()
      ) {
        await registration.update();
      }
    } catch {
      // Background update checks are best-effort; the next visible interval can retry.
    } finally {
      updateCheckInFlight = false;
      if (!running || checkGeneration !== lifecycleGeneration) {
        lastUpdateCheckAt = Number.NEGATIVE_INFINITY;
      }
    }
  };

  const onVisibilityChange = () => {
    if (runtime.isVisible()) void checkForUpdate();
  };

  return {
    start: () => {
      startCount += 1;
      if (!running) {
        running = true;
        lifecycleGeneration += 1;
        const removeControllerListener = runtime.onControllerChange(onControllerChange);
        const removeVisibilityListener = runtime.onVisibilityChange(onVisibilityChange);
        removeListeners = () => {
          removeControllerListener();
          removeVisibilityListener();
          running = false;
          lifecycleGeneration += 1;
          removeListeners = undefined;
        };
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        startCount -= 1;
        if (startCount === 0) removeListeners?.();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    registerReloadGuard: (guard) => {
      reloadGuards.add(guard);
      return () => {
        reloadGuards.delete(guard);
      };
    },
    registerManualReloadGuard: (guard) => {
      manualReloadGuards.add(guard);
      refreshGuardState();
      return () => {
        manualReloadGuards.delete(guard);
        refreshGuardState();
      };
    },
    refreshGuardState,
    reloadToApplyUpdate: () => {
      refreshGuardState();
      if (!running || !snapshot.updateAvailable || snapshot.manualReloadBlocked || reloadIssued)
        return;
      reloadIssued = true;
      runtime.reload();
    },
  };
}

let activeManager: PwaUpdateManager | undefined;

export function startPwaUpdateManager(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  activeManager ??= createPwaUpdateManager({
    getController: () => navigator.serviceWorker.controller,
    onControllerChange: (listener) => {
      navigator.serviceWorker.addEventListener('controllerchange', listener);
      return () => navigator.serviceWorker.removeEventListener('controllerchange', listener);
    },
    getRegistration: () => navigator.serviceWorker.getRegistration(),
    isVisible: () => document.visibilityState === 'visible',
    isOnline: () => navigator.onLine,
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    reload: () => window.location.reload(),
    now: () => Date.now(),
  });
  return activeManager.start();
}

export function subscribePwaUpdate(listener: () => void): () => void {
  return activeManager?.subscribe(listener) ?? (() => {});
}

export function getPwaUpdateSnapshot(): PwaUpdateSnapshot {
  return activeManager?.getSnapshot() ?? EMPTY_UPDATE_SNAPSHOT;
}

export function registerPwaReloadGuard(guard: () => boolean): () => void {
  if (!activeManager) return () => {};
  const unregister = activeManager.registerReloadGuard(guard);
  return () => {
    unregister();
    activeManager?.refreshGuardState();
  };
}

export function registerPwaManualReloadGuard(guard: () => boolean): () => void {
  return activeManager?.registerManualReloadGuard(guard) ?? (() => {});
}

export function refreshPwaGuardState(): void {
  activeManager?.refreshGuardState();
}

export function reloadToApplyPwaUpdate(): void {
  activeManager?.reloadToApplyUpdate();
}
