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

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T): T => fallback
  })
};

export const ProgressLocation = { Notification: 15 };
export const warnings: string[] = [];

export const window = {
  withProgress: async <T>(options: unknown, task: () => Promise<T>): Promise<T> => task(),
  showWarningMessage: (message: string) => { warnings.push(message); },
  showInformationMessage: async () => undefined,
  createOutputChannel: () => ({
    info: () => {},
    warn: () => {},
    error: () => {}
  })
};
