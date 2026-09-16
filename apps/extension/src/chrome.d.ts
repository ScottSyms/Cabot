// Minimal ambient declarations for chrome APIs used by the MV3 shell.
// Kept local so the workspace builds without @types/chrome.
interface ChromeRuntimePort {
  name: string;
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

interface ChromeApi {
  runtime: {
    onMessage: { addListener(fn: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => void): void };
    onConnect: { addListener(fn: (port: ChromeRuntimePort) => void): void };
    sendMessage(msg: unknown): Promise<unknown>;
  };
  alarms: {
    create(name: string, info: { periodInMinutes?: number; when?: number }): void;
    onAlarm: { addListener(fn: (a: { name: string }) => void): void };
  };
  offscreen: {
    createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  sidePanel: {
    setPanelBehavior(opts: { openPanelOnActionClick: boolean }): Promise<void>;
  };
}

declare const chrome: ChromeApi;
