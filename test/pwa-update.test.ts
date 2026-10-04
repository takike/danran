import { type PwaUpdateManager, createPwaUpdateManager } from '@client/features/pwa/updateManager';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ManagerHarness {
  manager: PwaUpdateManager;
  emitControllerChange: () => void;
  emitVisibilityChange: () => void;
  setController: (controller: ServiceWorker | null) => void;
  setVisible: (visible: boolean) => void;
  setOnline: (online: boolean) => void;
  advance: (milliseconds: number) => void;
  reload: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  refreshGuardState: () => void;
}

function createHarness(
  initialController: ServiceWorker | null = null,
  getRegistration?: () => Promise<ServiceWorkerRegistration | null | undefined>,
): ManagerHarness {
  let controller = initialController;
  let controllerChangeListener = () => {};
  let visibilityChangeListener = () => {};
  let visible = true;
  let online = true;
  let now = 0;
  const reload = vi.fn();
  const update = vi.fn(async () => {});
  const registration = { update } as unknown as ServiceWorkerRegistration;

  const manager = createPwaUpdateManager({
    getController: () => controller,
    onControllerChange: (listener) => {
      controllerChangeListener = listener;
      return () => {
        controllerChangeListener = () => {};
      };
    },
    getRegistration: getRegistration ?? (async () => registration),
    isVisible: () => visible,
    isOnline: () => online,
    onVisibilityChange: (listener) => {
      visibilityChangeListener = listener;
      return () => {
        visibilityChangeListener = () => {};
      };
    },
    reload,
    now: () => now,
    minUpdateCheckIntervalMs: 60_000,
  });

  return {
    manager,
    emitControllerChange: () => controllerChangeListener(),
    emitVisibilityChange: () => visibilityChangeListener(),
    setController: (nextController) => {
      controller = nextController;
    },
    setVisible: (nextVisible) => {
      visible = nextVisible;
    },
    setOnline: (nextOnline) => {
      online = nextOnline;
    },
    advance: (milliseconds) => {
      now += milliseconds;
    },
    reload,
    update,
    refreshGuardState: () => manager.refreshGuardState(),
  };
}

const worker = (): ServiceWorker => ({}) as ServiceWorker;

describe('PWA update manager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reload on first control, then reloads once when a newer worker takes over', () => {
    const harness = createHarness();
    const stop = harness.manager.start();
    const firstController = worker();
    harness.setController(firstController);
    harness.emitControllerChange();

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.manager.getSnapshot()).toEqual({
      updateAvailable: false,
      manualReloadBlocked: false,
    });

    const replacementController = worker();
    harness.setController(replacementController);
    harness.emitControllerChange();
    harness.emitControllerChange();

    expect(harness.reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps a guarded draft open, publishes the update, and reloads only after explicit apply', () => {
    const firstController = worker();
    const harness = createHarness(firstController);
    const listener = vi.fn();
    harness.manager.subscribe(listener);
    const unregisterGuard = harness.manager.registerReloadGuard(() => true);
    const stop = harness.manager.start();

    harness.setController(worker());
    harness.emitControllerChange();
    harness.emitControllerChange();

    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.manager.getSnapshot()).toEqual({
      updateAvailable: true,
      manualReloadBlocked: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unregisterGuard();
    expect(harness.manager.getSnapshot().updateAvailable).toBe(true);
    expect(harness.reload).not.toHaveBeenCalled();

    harness.manager.reloadToApplyUpdate();
    harness.manager.reloadToApplyUpdate();
    expect(harness.reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('blocks manual reload while a protected mutation is pending, then allows explicit apply', () => {
    const harness = createHarness(worker());
    let mutationPending = true;
    harness.manager.registerReloadGuard(() => mutationPending);
    harness.manager.registerManualReloadGuard(() => mutationPending);
    const stop = harness.manager.start();

    harness.setController(worker());
    harness.emitControllerChange();
    expect(harness.manager.getSnapshot()).toEqual({
      updateAvailable: true,
      manualReloadBlocked: true,
    });
    harness.manager.reloadToApplyUpdate();
    expect(harness.reload).not.toHaveBeenCalled();

    mutationPending = false;
    harness.refreshGuardState();
    expect(harness.manager.getSnapshot()).toEqual({
      updateAvailable: true,
      manualReloadBlocked: false,
    });
    expect(harness.reload).not.toHaveBeenCalled();
    harness.manager.reloadToApplyUpdate();
    expect(harness.reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('checks for updates only while visible and online, with a throttle between checks', async () => {
    const harness = createHarness(worker());
    const stop = harness.manager.start();

    harness.setVisible(false);
    harness.emitVisibilityChange();
    harness.setVisible(true);
    harness.setOnline(false);
    harness.emitVisibilityChange();
    expect(harness.update).not.toHaveBeenCalled();

    harness.setOnline(true);
    harness.emitVisibilityChange();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledTimes(1));

    harness.emitVisibilityChange();
    await Promise.resolve();
    expect(harness.update).toHaveBeenCalledTimes(1);

    harness.advance(60_000);
    harness.emitVisibilityChange();
    await vi.waitFor(() => expect(harness.update).toHaveBeenCalledTimes(2));
    stop();
  });

  it('does not run a pending update check after its manager is disposed', async () => {
    let resolveRegistration: (registration: ServiceWorkerRegistration) => void = () => {};
    const registrationPromise = new Promise<ServiceWorkerRegistration>((resolve) => {
      resolveRegistration = resolve;
    });
    const harness = createHarness(worker(), () => registrationPromise);
    const listener = vi.fn();
    harness.manager.subscribe(listener);
    const stop = harness.manager.start();

    harness.emitVisibilityChange();
    await Promise.resolve();
    stop();
    resolveRegistration({ update: harness.update } as unknown as ServiceWorkerRegistration);
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.update).not.toHaveBeenCalled();
    harness.setController(worker());
    harness.emitControllerChange();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
