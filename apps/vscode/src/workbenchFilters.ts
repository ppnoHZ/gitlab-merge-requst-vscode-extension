import * as vscode from 'vscode';
import { WorkbenchFilters, MainFilter, RiskFilter, UpdatedFilter, mainLabels, riskLabels, updatedLabels } from '@gitlab-workbench/core';
export * from '@gitlab-workbench/core';

// A cancelled picker leaves all existing dimensions intact. Empty multi-selection means all.
export async function pickWorkbenchFilters(current: WorkbenchFilters, risks: boolean): Promise<WorkbenchFilters | undefined> {
  const dimension = await vscode.window.showQuickPick([
    { label: 'main 合入状态', key: 'main' },
    ...(risks ? [{ label: '上线风险', key: 'risks' }] : []),
    { label: '最近更新时间', key: 'updated' }
  ], { title: '筛选条件', placeHolder: '不同条件取交集；同一条件多选取并集' });
  if (!dimension) return undefined;
  if (dimension.key === 'updated') {
    const selection = await vscode.window.showQuickPick(
      (Object.keys(updatedLabels) as UpdatedFilter[]).map(key => ({ key, label: updatedLabels[key], description: current.updated === key ? '当前选择' : undefined })),
      { title: '最近更新时间', placeHolder: '按分支最新提交时间筛选；无有效时间的数据归为未知' });
    return selection ? { ...current, updated: selection.key } : undefined;
  }
  if (dimension.key === 'main') {
    const selection = await vscode.window.showQuickPick(
      (Object.keys(mainLabels) as MainFilter[]).map(key => ({ key, label: mainLabels[key], picked: current.main.includes(key) })),
      { title: 'main 合入状态', canPickMany: true, placeHolder: '多选；清空选择表示全部状态' });
    return selection === undefined ? undefined : { ...current, main: selection.map(item => item.key) };
  }
  const selection = await vscode.window.showQuickPick(
    (Object.keys(riskLabels) as RiskFilter[]).map(key => ({ key, label: riskLabels[key], picked: current.risks.includes(key) })),
    { title: '上线风险', canPickMany: true, placeHolder: '多选；清空选择表示全部风险' });
  return selection === undefined ? undefined : { ...current, risks: selection.map(item => item.key) };
}
