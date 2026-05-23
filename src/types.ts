export type Repo = {
  id: string;
  name: string;
  path: string;
  remote: string;
  accent: "teal" | "blue" | "amber";
  present: boolean;
  branch: string;
  commit: string;
  dirty: boolean;
  statusText: string;
  lastCommit: string;
};

export type Automation = {
  id: string;
  name: string;
  repoId: string;
  timer: string;
  service: string;
  schedule: string;
  model: string;
  reasoning: string;
  enabled: boolean;
  nextRun: string;
  lastRun: string;
  run: {
    activeState: string;
    failedState: string;
    exitCode: string;
    logName: string | null;
    logUpdatedAt: string | null;
    logTail: string[];
  };
};

export type LogFile = {
  id: string;
  job: string;
  name: string;
  size: number;
  updatedAt: string;
  tail: string[];
};

export type ConsoleStatus = {
  generatedAt: string;
  localMode: boolean;
  instance: {
    name: string;
    region: string;
    publicIp: string;
    privateIp: string;
    type: string;
    root: string;
  };
  codex: {
    authenticated: boolean;
    mode: string;
    detail: string;
  };
  repos: Repo[];
  automations: Automation[];
  logs: LogFile[];
  events: Array<{ tone: "ok" | "warn" | "info"; text: string }>;
};

export type ChatSessionRuntime = {
  codexSessionId?: string | null;
  model?: string | null;
  reasoning?: string | null;
  sandbox?: string | null;
};
