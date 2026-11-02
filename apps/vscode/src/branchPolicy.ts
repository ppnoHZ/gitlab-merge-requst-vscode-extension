export interface BranchPolicyTemplates { release: string; hotfix: string; conflict: string }
export const defaultBranchPolicy: BranchPolicyTemplates = {
  release: 'release/{version}', hotfix: 'hotfix/{version}/{issue}{descriptionSuffix}', conflict: 'conflict/{source}'
};

const safeRef = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|\s|[~^:?*\[]))(?!.*(?:\.|\.lock)$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/;

export function renderBranchTemplate(template: string, values: Record<string, string | undefined>): string {
  const unknown = [...template.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).filter(key => !(key in values));
  if (unknown.length) throw new Error(`分支模板包含未知变量：${[...new Set(unknown)].join(', ')}`);
  const rendered = template.replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? '').replace(/\/{2,}/g, '/');
  if (!safeRef.test(rendered) || rendered.split('/').some(part => !part)) throw new Error(`生成的分支名不符合 Git ref 规范：${rendered}`);
  return rendered;
}

export function validateManagedBranch(name: string, templates: BranchPolicyTemplates = defaultBranchPolicy): { valid: boolean; kind?: keyof BranchPolicyTemplates; message?: string } {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = (template: string) => new RegExp(`^${escaped(template).replace(/\\\{(?:version|issue|descriptionSuffix|source)\\\}/g, '.+?')}$`);
  const kind = (Object.keys(templates) as Array<keyof BranchPolicyTemplates>).find(key => pattern(templates[key]).test(name));
  if (kind) return { valid: true, kind };
  if (/^(release|hotfix|conflict)\//.test(name)) return { valid: false, message: '分支名称不符合当前公司模板；插件仅提示，不会修改现有分支。' };
  return { valid: true };
}
