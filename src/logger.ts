import * as vscode from 'vscode';

export class Logger {
  private static channel: vscode.OutputChannel;

  static init(): void {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('GitLab MR');
    }
  }

  private static formatTime(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${now.getMilliseconds().toString().padStart(3, '0')}`;
  }

  static info(message: string, ...args: any[]): void {
    this.init();
    const formattedArgs = args.length > 0 ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : a)).join(' ') : '';
    const line = `[${this.formatTime()}] [INFO] ${message}${formattedArgs}`;
    this.channel.appendLine(line);
    console.log(line);
  }

  static warn(message: string, ...args: any[]): void {
    this.init();
    const formattedArgs = args.length > 0 ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : a)).join(' ') : '';
    const line = `[${this.formatTime()}] [WARN] ${message}${formattedArgs}`;
    this.channel.appendLine(line);
    console.warn(line);
  }

  static error(message: string, error?: any): void {
    this.init();
    let errorDetails = '';
    if (error) {
      if (error instanceof Error) {
        errorDetails = `\n  Message: ${error.message}${error.stack ? `\n  Stack: ${error.stack}` : ''}`;
      } else if (typeof error === 'object') {
        errorDetails = `\n  Details: ${JSON.stringify(error, null, 2)}`;
      } else {
        errorDetails = `\n  Details: ${error}`;
      }
    }
    const line = `[${this.formatTime()}] [ERROR] ${message}${errorDetails}`;
    this.channel.appendLine(line);
    console.error(line);
  }

  static show(preserveFocus = false): void {
    this.init();
    this.channel.show(preserveFocus);
  }

  static dispose(): void {
    if (this.channel) {
      this.channel.dispose();
    }
  }
}
