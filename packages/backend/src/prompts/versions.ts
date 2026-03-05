const DEFAULT_PROMPT_VERSIONS = {
  analysis: "2.0.0",
  chat: "2.1.1",
  memory: "2.0.1"
} as const;

export type PromptName = keyof typeof DEFAULT_PROMPT_VERSIONS;

export interface PromptChangelogItem {
  date: string;
  changes: string[];
  breaking: boolean;
}

export const PROMPT_CHANGELOG: Record<string, PromptChangelogItem> = {
  "analysis-2.0.0": {
    date: "2026-03-04",
    changes: [
      "新增版本治理基线",
      "为分析阶段预留 memory weaving 路由字段"
    ],
    breaking: true
  },
  "chat-2.1.0": {
    date: "2026-03-04",
    changes: [
      "新增版本治理基线",
      "为回答阶段预留 source-aware 规则扩展位"
    ],
    breaking: false
  },
  "chat-2.1.1": {
    date: "2026-03-04",
    changes: [
      "身份问句补充身份槽位优先规则",
      "补充低质量身份条目忽略约束"
    ],
    breaking: false
  },
  "memory-2.0.0": {
    date: "2026-03-04",
    changes: [
      "新增版本治理基线",
      "为 should_store 扩展保留版本锚点"
    ],
    breaking: true
  },
  "memory-2.0.1": {
    date: "2026-03-04",
    changes: [
      "补充低质量身份挑衅表达拒绝规则",
      "新增“我是你爹”负例示例"
    ],
    breaking: false
  }
};

function resolvePromptVersion(name: PromptName): string {
  const envKey = `PROMPT_VERSION_${name.toUpperCase()}` as const;
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return DEFAULT_PROMPT_VERSIONS[name];
}

export const PROMPT_VERSIONS: Record<PromptName, string> = Object.freeze({
  analysis: resolvePromptVersion("analysis"),
  chat: resolvePromptVersion("chat"),
  memory: resolvePromptVersion("memory")
});

export function getPromptVersions(): Record<PromptName, string> {
  return {
    analysis: PROMPT_VERSIONS.analysis,
    chat: PROMPT_VERSIONS.chat,
    memory: PROMPT_VERSIONS.memory
  };
}
