import * as vscode from 'vscode';
import { Logger } from './logger';

/** High-volume diagnostics are opt-in; operational warnings/errors stay at their callers. */
export function debugLog(message: string, ...args: unknown[]): void {
  if (vscode.workspace.getConfiguration('gitlabMr').get<boolean>('verboseLogging', false)) {
    Logger.info(`[诊断] ${message}`, ...args);
  }
}
