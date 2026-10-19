export enum TreeItemCollapsibleState {
  None,
  Collapsed,
  Expanded
}

export class TreeItem {
  constructor(public label: string, public collapsibleState: TreeItemCollapsibleState) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(value => value !== listener); } };
  };

  fire(value: T): void {
    this.listeners.forEach(listener => listener(value));
  }

  dispose(): void {
    this.listeners = [];
  }
}

export const configuration = new Map<string, unknown>();
export const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T): T => configuration.has(key) ? configuration.get(key) as T : fallback,
    inspect: (key: string) => ({ globalValue: configuration.get(key) })
  })
};

export const ProgressLocation = { Notification: 15 };
export const warnings: string[] = [];
export const warningDialog = {
  value: undefined as string | undefined,
  modal: false,
  onShow: undefined as (() => void) | undefined
};
export const informationMessages: string[] = [];
export const errorMessages: string[] = [];
export const titleInput = { value: undefined as string | undefined, titles: [] as string[] };
export const targetPick = {
  value: undefined as string | undefined,
  items: [] as Array<{ label: string; description?: string }>
};
export const openedUrls: string[] = [];
export const clipboard = {
  text: '',
  error: undefined as Error | undefined
};
export const Uri = {
  parse: (value: string) => value,
  from: (components: { scheme: string; path: string }) => ({
    scheme: components.scheme,
    path: components.path,
    toString: () => `${components.scheme}:${encodeURI(components.path)}`
  })
};
export const executedCommands: Array<{ command: string; args: unknown[] }> = [];
export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    executedCommands.push({ command, args });
  }
};
export const env = {
  clipboard: {
    writeText: async (text: string) => {
      if (clipboard.error) {
        throw clipboard.error;
      }
      clipboard.text = text;
    }
  },
  openExternal: async (uri: string) => { openedUrls.push(uri); return true; }
};

export const window = {
  showErrorMessage: async (message: string) => { errorMessages.push(message); },
  showQuickPick: async (items: Array<{ label: string; description?: string }>) => {
    targetPick.items = items;
    return items.find(item => item.label === targetPick.value);
  },
  withProgress: async <T>(
    options: unknown,
    task: (progress: { report: (value: unknown) => void }) => Promise<T>
  ): Promise<T> => task({ report: () => {} }),
  showInputBox: async (options: { value?: string }) => {
    titleInput.titles.push(options.value ?? '');
    return titleInput.value;
  },
  showWarningMessage: async (message: string, options?: { modal?: boolean }, ..._items: string[]) => {
    warnings.push(message);
    warningDialog.modal = options?.modal === true;
    warningDialog.onShow?.();
    return warningDialog.value;
  },
  showInformationMessage: async (message: string) => {
    informationMessages.push(message);
    return undefined;
  },
  createOutputChannel: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
};
