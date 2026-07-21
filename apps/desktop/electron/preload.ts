// preload：通过 contextBridge 暴露受限的类型化 API。Renderer 无 Node 权限。
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, StreamEvent, AiStreamEvent } from './api.js';
import type { AiChatMessage } from '@ai-devflow/core';

const invoke = (ns: string, method: string) => (...args: unknown[]) =>
  ipcRenderer.invoke(`ai-devflow:${ns}:${method}`, ...args);

const api: DesktopApi = {
  projects: {
    list: () => invoke('projects', 'list')(),
    create: (input) => invoke('projects', 'create')(input),
    pickFolder: () => invoke('projects', 'pickFolder')(),
    createAtPath: (input) => invoke('projects', 'createAtPath')(input),
    update: (p) => invoke('projects', 'update')(p),
    delete: (id) => invoke('projects', 'delete')(id),
  },
  iterations: {
    list: (projectId) => invoke('iterations', 'list')(projectId),
    create: (projectId, name, version) => invoke('iterations', 'create')(projectId, name, version),
    archive: (id) => invoke('iterations', 'archive')(id),
  },
  requirements: {
    list: (iterationId) => invoke('requirements', 'list')(iterationId),
    get: (id) => invoke('requirements', 'get')(id),
    create: (iterationId, title, description, priority, acceptance) =>
      invoke('requirements', 'create')(iterationId, title, description, priority, acceptance),
    update: (r) => invoke('requirements', 'update')(r),
    archive: (id) => invoke('requirements', 'archive')(id),
  },
  tasks: {
    listByIteration: (iterationId) => invoke('tasks', 'listByIteration')(iterationId),
    listByProject: (projectId) => invoke('tasks', 'listByProject')(projectId),
    listAll: () => invoke('tasks', 'listAll')(),
    listByRequirement: (requirementId) => invoke('tasks', 'listByRequirement')(requirementId),
    get: (id) => invoke('tasks', 'get')(id),
    create: (input) => invoke('tasks', 'create')(input),
    update: (input) => invoke('tasks', 'update')(input),
    updateStatus: (id, target) => invoke('tasks', 'updateStatus')(id, target),
    pause: (id) => invoke('tasks', 'pause')(id),
    start: (id) => invoke('tasks', 'start')(id),
    resume: (id, answer) => invoke('tasks', 'resume')(id, answer),
    cancel: (id) => invoke('tasks', 'cancel')(id),
    retry: (id) => invoke('tasks', 'retry')(id),
    logs: (id) => invoke('tasks', 'logs')(id),
    executions: (id) => invoke('tasks', 'executions')(id),
    pendingQuestion: (id) => invoke('tasks', 'pendingQuestion')(id),
  },
  agents: {
    detectAll: () => invoke('agents', 'detectAll')(),
    detect: (type) => invoke('agents', 'detect')(type),
  },
  notificationRules: {
    list: () => invoke('notificationRules', 'list')(),
    create: (rule) => invoke('notificationRules', 'create')(rule),
    update: (r) => invoke('notificationRules', 'update')(r),
    delete: (id) => invoke('notificationRules', 'delete')(id),
  },
  webhooks: {
    list: () => invoke('webhooks', 'list')(),
    create: (input) => invoke('webhooks', 'create')(input),
    update: (w) => invoke('webhooks', 'update')(w),
    delete: (id) => invoke('webhooks', 'delete')(id),
    test: (id) => invoke('webhooks', 'test')(id),
    deliveries: (id) => invoke('webhooks', 'deliveries')(id),
  },
  settings: {
    getLocale: () => invoke('settings', 'getLocale')(),
    setLocale: (locale) => invoke('settings', 'setLocale')(locale),
    getAiProvider: () => invoke('settings', 'getAiProvider')(),
    setAiProvider: (cfg) => invoke('settings', 'setAiProvider')(cfg),
    getProjectSettings: (projectId) => invoke('settings', 'getProjectSettings')(projectId),
    updateProjectSettings: (projectId, settings) => invoke('settings', 'updateProjectSettings')(projectId, settings),
  },
  ai: {
    // 流式对话：主进程通过 ai-devflow:ai-stream 频道回传增量/完成/错误。
    chat(
      messages: AiChatMessage[],
      onChunk: (delta: string) => void,
      opts?: { mode?: 'task' | 'requirement'; context?: string },
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        const sessionId = globalThis.crypto.randomUUID();
        const listener = (_e: unknown, ev: AiStreamEvent) => {
          if (ev.sessionId !== sessionId) return;
          if (ev.type === 'delta') {
            onChunk(ev.text);
          } else if (ev.type === 'done') {
            ipcRenderer.removeListener('ai-devflow:ai-stream', listener);
            resolve(ev.fullText);
          } else if (ev.type === 'error') {
            ipcRenderer.removeListener('ai-devflow:ai-stream', listener);
            reject(new Error(ev.error));
          }
        };
        ipcRenderer.on('ai-devflow:ai-stream', listener);
        ipcRenderer.send('ai-devflow:ai:chat', { sessionId, messages, mode: opts?.mode, context: opts?.context });
      });
    },
    propose: (messages, context) => invoke('ai', 'propose')(messages, context),
    proposeRequirement: (messages) => invoke('ai', 'proposeRequirement')(messages),
  },
  events: {
    subscribe(handler) {
      const listener = (_e: unknown, ev: StreamEvent) => handler(ev);
      ipcRenderer.on('ai-devflow:stream', listener);
      return () => ipcRenderer.removeListener('ai-devflow:stream', listener);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
