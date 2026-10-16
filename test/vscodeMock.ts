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
export const informationMessages: string[] = [];
export const titleInput = { value: undefined as string | undefined, titles: [] as string[] };
export const targetPick = {
  value: undefined as string | undefined,
  items: [] as Array<{ label: string; description?: string }>
};
export const openedUrls: string[] = [];
export const Uri = { parse: (value: string) => value };
export const env = {
  openExternal: async (uri: string) => { openedUrls.push(uri); }
};

export const window = {
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
  showWarningMessage: (message: string) => { warnings.push(message); },
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
