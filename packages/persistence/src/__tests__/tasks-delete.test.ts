import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, createRepositories, type Repositories, type DatabaseSync } from '../index.js';

// 子任务删除（需求 1 后端）的仓库层基线：delete + listByRequirement 已存在；
// 依赖守卫逻辑（被 dependsOn 引用时拒绝）落在 ipc 层，本测试覆盖仓库层能力与 dependsOn 读取。
let db: DatabaseSync;
let repos: Repositories;

function seed(): void {
  repos.projects.insert({ id: 'p1', name: 'P', path: '/p', defaultBranch: 'main', createdAt: 0, updatedAt: 0, settings: {} });
  repos.iterations.insert({ id: 'it1', projectId: 'p1', name: 'I', version: 'v1', status: 'active', createdAt: 0 });
  repos.requirements.insert({ id: 'r1', iterationId: 'it1', title: 'R', description: '', priority: 'medium', acceptance: '', createdAt: 0, archived: false });
  const mk = (id: string, dependsOn: string[]): void => {
    repos.tasks.insert({
      id, requirementId: 'r1', iterationId: 'it1', projectId: 'p1',
      title: id, description: '', status: 'ready', role: 'coder',
      stages: [], currentStage: 0, statusChangedAt: 0, createdAt: 0, updatedAt: 0, retryCount: 0, dependsOn,
    });
  };
  mk('A', []);
  mk('B', ['A']);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepositories(db);
  seed();
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

describe('tasks delete with dependency guard', () => {
  it('listByRequirement 返回同需求全部子任务（含 dependsOn）', () => {
    const siblings = repos.tasks.listByRequirement('r1');
    expect(siblings.map((t) => t.id).sort()).toEqual(['A', 'B']);
    const b = siblings.find((t) => t.id === 'B');
    expect(b?.dependsOn).toEqual(['A']);
  });

  it('被依赖任务删除前可识别其阻塞者（守卫依据）', () => {
    const siblings = repos.tasks.listByRequirement('r1');
    const blockers = siblings.filter((t) => t.id !== 'A' && (t.dependsOn ?? []).includes('A'));
    expect(blockers.map((b) => ({ id: b.id, title: b.title }))).toEqual([{ id: 'B', title: 'B' }]);
    // 守卫未通过时不执行删除
    expect(repos.tasks.get('A')).toBeDefined();
  });

  it('无依赖任务可删除（守卫通过）', () => {
    const siblings = repos.tasks.listByRequirement('r1');
    const blockers = siblings.filter((t) => t.id !== 'B' && (t.dependsOn ?? []).includes('B'));
    expect(blockers).toEqual([]);
    repos.tasks.delete('B');
    expect(repos.tasks.get('B')).toBeUndefined();
    // 删除 B 后 A 不受影响
    expect(repos.tasks.get('A')).toBeDefined();
  });
});
