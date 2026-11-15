import { config } from "../package.json";
import { installDock } from "./dock";

type MainWindow = Window & { closed?: boolean };
const zotero = _globalThis.Zotero as unknown as Record<string, unknown>;
const cleanups = new Map<MainWindow, () => void>();

const addon = {
  data: { initialized: false },
  hooks: {
    async onStartup(): Promise<void> {
      await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
      ]);
      for (const window of Zotero.getMainWindows() as unknown as MainWindow[]) {
        this.onMainWindowLoad(window);
      }
      addon.data.initialized = true;
    },
    onMainWindowLoad(window: MainWindow): void {
      if (cleanups.has(window) || window.closed) return;
      cleanups.set(window, installDock(window));
    },
    onMainWindowUnload(window: MainWindow): void {
      const cleanup = cleanups.get(window);
      cleanups.delete(window);
      cleanup?.();
    },
    onShutdown(): void {
      for (const window of [...cleanups.keys()]) this.onMainWindowUnload(window);
      addon.data.initialized = false;
      delete zotero[config.addonInstance];
    },
  },
};

zotero[config.addonInstance] = addon;
