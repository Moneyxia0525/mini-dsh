/**
 * Service key 常量。插件通过统一 key 注册/注入服务，
 * 避免散落的魔法字符串，保证可替换性。
 */
export const SERVICES = {
  MODEL: "service.model",
  TOOLS: "service.tools",
  SESSION: "service.session",
  PERMISSION: "service.permission",
  CONTEXT_MANAGER: "service.context-manager",
  PROMPT_OPTIMIZER: "service.prompt-optimizer",
  LOOP: "service.loop",
  EVENT_BUS: "service.event-bus",
  PLANNER: "service.planner",
  VERIFIER: "service.verifier",
} as const;

/** 事件名 */
export const EVENTS = {
  AGENT_START: "agent.start",
  AGENT_MODEL_REQUEST: "agent.model-request",
  AGENT_MODEL_RESPONSE: "agent.model-response",
  AGENT_MODEL_DELTA: "agent.model-delta",
  AGENT_TOOL_CALL: "agent.tool-call",
  AGENT_TOOL_RESULT: "agent.tool-result",
  AGENT_DONE: "agent.done",
  AGENT_ABORT: "agent.abort",
  AGENT_ERROR: "agent.error",
  PERMISSION_DENIED: "permission.denied",
  PERMISSION_CONFIRM: "permission.confirm",
  CONTEXT_COMPRESSED: "context.compressed",
  PLAN_CREATED: "agent.plan-created",
  VERIFICATION_STARTED: "agent.verification-started",
  VERIFICATION_RESULT: "agent.verification-result",
  CHECKPOINT_SAVED: "agent.checkpoint-saved",
  MODEL_AUX_USAGE: "model.aux-usage",
} as const;
