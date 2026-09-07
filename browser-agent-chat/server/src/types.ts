// === Database Models ===

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  url: string;
  credentials: EncryptedCredentials | null;
  context: string | null;
  created_at: string;
  updated_at: string;
}

export interface EncryptedCredentials {
  iv: string;
  encrypted: string;
  tag: string;
}

export interface PlaintextCredentials {
  username: string;
  password: string;
}

// --- Credential Vault Types ---

export interface PlaintextSecret {
  password?: string;
  apiKey?: string;
}

export interface VaultEntry {
  id: string;
  user_id: string;
  label: string;
  credential_type: string;
  metadata: { username?: string; notes?: string };
  domains: string[];
  scope: string;
  version: number;
  use_count: number;
  last_used_at: string | null;
  last_used_by_agent: string | null;
  created_by_agent: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoundCredential extends VaultEntry {
  usage_context: string | null;
  priority: number;
  binding_id: string;
}

export interface LoginDetectionResult {
  score: number;
  isLoginPage: boolean;
  selectors: {
    username: string | null;
    password: string | null;
    submit: string | null;
  };
  domain: string;
  strategy: 'standard_form' | 'two_step' | 'unknown';
}

export interface LoginPattern {
  domain: string;
  credential_id: string;
  strategy: 'standard_form';
  username_selector: string;
  password_selector: string;
  submit_selector: string;
}

export interface LoginResult {
  success: boolean;
  error?: string;
}

export interface Feature {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  criticality: Criticality;
  expected_behaviors: string[];
  created_at: string;
  updated_at: string;
  flows?: Flow[];
}

export interface Flow {
  id: string;
  feature_id: string;
  agent_id: string;
  name: string;
  steps: FlowStep[];
  checkpoints: Checkpoint[];
  criticality: Criticality;
  created_at: string;
  updated_at: string;
}

export interface FlowStep {
  order: number;
  description: string;
  url?: string;
}

export interface Checkpoint {
  description: string;
  expected: string;
}

export interface Finding {
  id: string;
  agent_id: string;
  session_id: string;
  title: string;
  description: string | null;
  type: FindingType;
  severity: Criticality;
  feature: string | null;
  flow: string | null;
  steps_to_reproduce: ReproStep[];
  expected_behavior: string | null;
  actual_behavior: string | null;
  screenshot_url: string | null;
  status: FindingStatus;
  created_at: string;
}

export interface ReproStep {
  order: number;
  action: string;
  target?: string;
}

export interface Session {
  id: string;
  agent_id: string;
  started_at: string;
  ended_at: string | null;
  findings_count: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

// === Enums ===

export type Criticality = 'critical' | 'high' | 'medium' | 'low';
export type FindingType = 'visual' | 'functional' | 'data' | 'ux';
export type FindingStatus = 'new' | 'confirmed' | 'dismissed';
export type MessageRole = 'user' | 'agent' | 'thought' | 'action' | 'system';
export type AgentStatus = 'idle' | 'working' | 'error' | 'disconnected' | 'crashed' | 'interrupted';

// === Redis Session State ===

export interface RedisSession {
  dbSessionId: string;
  status: RedisSessionStatus;
  cdpPort: number;
  cdpEndpoint: string;
  currentUrl: string;
  memoryContext: string;
  browserPid: number;
  lastTask: string;
  createdAt: number;
  lastActivityAt: number;
  detachedAt: number;  // 0 = not detached, Date.now() = detach timestamp
}

export type RedisSessionStatus = 'idle' | 'working' | 'disconnected' | 'crashed' | 'interrupted';

// === Navigation Graph ===

export interface NavNode {
  id: string;
  agentId: string;
  urlPattern: string;
  pageTitle: string;
  description: string;
  firstSeenAt: string;
  lastSeenAt: string;
  features: string[]; // feature names, populated from nav_node_features join
}

export interface NavEdge {
  id: string;
  agentId: string;
  fromNodeId: string;
  toNodeId: string;
  actionLabel: string;
  selector: string | null;
  rawTarget: string | null;
  discoveredAt: string;
}

export interface NavGraph {
  nodes: NavNode[];
  edges: NavEdge[];
}

// === Muscle Memory ===

export type PatternState = 'candidate' | 'active' | 'dominant' | 'stale' | 'archived';
export type PatternScope = 'agent' | 'org' | 'candidate_global' | 'verified_global' | 'global';

export interface LearnedPattern {
  id: string;
  agent_id: string;
  pattern_type: 'login' | 'navigation' | 'task';
  trigger: LoginTrigger;
  steps: PlaywrightStep[];
  consecutive_failures: number;
  pattern_state: PatternState;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  // Learning system extensions
  scope: PatternScope;
  embedding: number[] | null;
  cluster_id: string | null;
  avg_steps: number | null;
  avg_duration_ms: number | null;
  success_rate: number | null;
  variance: number | null;
  score: number | null;
  org_id: string | null;
  source_agent_id: string | null;
  app_fingerprint: string | null;
  last_verified_success: string | null;
  portability_score: number | null;
  domain?: string;
  credential_id?: string;  // Reference to credentials_vault.id
}

export interface LoginTrigger {
  type: 'login';
  url_pattern: string;
}

export interface PlaywrightStep {
  action: 'fill' | 'click' | 'type' | 'press';
  selector: string;
  value?: string;
  waitAfter?: number;
}

// --- Learning System Types ---

export type FeedbackRating = 'positive' | 'negative';

export interface TaskFeedback {
  id: string;
  agent_id: string;
  task_id: string;
  session_id: string | null;
  rating: FeedbackRating;
  correction: string | null;
  created_at: string;
}

export interface LearningPoolEntry {
  id: string;
  cluster_id: string | null;
  task_id: string;
  agent_id: string;
  feedback: FeedbackRating;
  task_prompt: string;
  task_prompt_embedding: number[] | null;
  task_summary: string | null;
  task_summary_embedding: number[] | null;
  steps: Array<{ step_order: number; step_type: string; content: string; target?: string; duration_ms?: number }>;
  step_count: number;
  duration_ms: number | null;
  created_at: string;
}

export interface TaskCluster {
  id: string;
  agent_id: string | null;
  org_id: string | null;
  centroid_embedding: number[];
  task_summary: string;
  run_count: number;
  app_fingerprint: string | null;
  created_at: string;
}

// === Suggestions ===

export interface Suggestion {
  id: string;
  agent_id: string;
  type: 'feature' | 'flow' | 'behavior';
  status: 'pending' | 'accepted' | 'dismissed';
  data: FeatureSuggestionData | FlowSuggestionData | BehaviorSuggestionData;
  source_session: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface FeatureSuggestionData {
  name: string;
  description: string;
  criticality: Criticality;
  expected_behaviors: string[];
  discovered_at_url?: string; // URL where feature was observed during exploration
  aliases?: string[]; // Alternative names detected by entity resolver
}

export interface FlowSuggestionData {
  feature_name: string;
  name: string;
  steps: FlowStep[];
  checkpoints: Checkpoint[];
  criticality: Criticality;
  discovered_at_url?: string;
  aliases?: string[]; // Alternative names detected by entity resolver
}

export interface BehaviorSuggestionData {
  feature_name: string;
  behavior: string;
}

// === WebSocket Messages ===

export type ClientMessage =
  | { type: 'start'; agentId: string; resumeUrl?: string }
  | { type: 'restart'; agentId: string }
  | { type: 'task'; content: string }
  | { type: 'explore'; agentId: string }
  | { type: 'ping' }
  | { type: 'taskFeedback'; task_id: string; rating: FeedbackRating; correction?: string }
  | { type: 'credential_provided'; credentialId: string };

export type ServerMessage =
  | { type: 'thought'; content: string }
  | { type: 'action'; action: string; target?: string }
  | { type: 'screenshot'; data: string }
  | { type: 'status'; status: AgentStatus }
  | { type: 'nav'; url: string }
  | { type: 'error'; message: string }
  | { type: 'taskStarted'; taskId: string }
  | { type: 'taskComplete'; success: boolean; taskId?: string; stepCount?: number; durationMs?: number }
  | { type: 'finding'; finding: Finding }
  | { type: 'suggestion'; suggestion: Suggestion }
  | { type: 'pong' }
  | { type: 'sessionRestore'; messages: ChatMessage[] }
  | { type: 'metrics'; metrics: StartupMetrics }
  | { type: 'sessionCrashed' }
  | { type: 'taskInterrupted'; task: string }
  | { type: 'evalProgress'; runId: string; completed: number; total: number; latest: { case: string; verdict: string } }
  | { type: 'evalComplete'; runId: string; summary: { total: number; passed: number; failed: number; errorBreakdown: Record<string, number> } }
  | { type: 'patternLearned'; name: string; steps: string[]; success_rate: number; avg_steps: number; runs: number; transition: 'active' | 'dominant' }
  | { type: 'patternStale'; name: string; reason: string }
  | { type: 'feedbackAck'; taskId: string; rating: FeedbackRating; clustered: boolean; clusterName?: string; clusterProgress?: { current: number; needed: number } }
  | { type: 'credential_needed'; agentId: string; domain: string; strategy: string }
  | { type: 'session_evicted'; agentId: string; reason: 'capacity' }
  | { type: 'session_expiring'; remainingSeconds: number }
  | { type: 'session_new'; agentId: string };

// === API Request/Response ===

export interface CreateAgentRequest {
  name: string;
  url: string;
  credentials?: PlaintextCredentials;
  context?: string;
}

export interface AgentResponse {
  id: string;
  name: string;
  url: string;
  hasCredentials: boolean;
  context: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentListItem extends AgentResponse {
  findings_count: number;
  last_session_at: string | null;
}

export interface CreateFeatureRequest {
  name: string;
  description?: string;
  criticality: Criticality;
  expected_behaviors?: string[];
}

export interface CreateFlowRequest {
  name: string;
  steps: FlowStep[];
  checkpoints?: Checkpoint[];
  criticality: Criticality;
}

// === Startup Metrics ===

export interface MetricStep {
  name: string;
  duration: number;
}

export interface StartupMetrics {
  total: number;
  steps: MetricStep[];
}

// === Eval Framework Types ===

export type CheckType = 'url_matches' | 'element_exists' | 'element_absent' | 'text_contains' | 'page_title';

export type Check =
  | { type: 'url_matches'; pattern: string }
  | { type: 'element_exists'; selector: string }
  | { type: 'element_absent'; selector: string }
  | { type: 'text_contains'; selector: string; text: string }
  | { type: 'page_title'; pattern: string };

export type EvalCaseSourceType = 'feature' | 'flow' | 'finding' | 'manual';
export type EvalCaseStatus = 'active' | 'disabled';
export type EvalRunTrigger = 'manual' | 'scheduled' | 'ci';
export type EvalRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type EvalVerdict = 'pass' | 'fail' | 'error';

export type ErrorType =
  | 'navigation_failure'
  | 'element_not_found'
  | 'wrong_element'
  | 'action_timeout'
  | 'reasoning_error'
  | 'hallucination'
  | 'partial_completion'
  | 'unexpected_state'
  | 'tool_misuse';

export interface EvalCase {
  id: string;
  agent_id: string;
  name: string;
  task_prompt: string;
  source_type: EvalCaseSourceType;
  source_id: string | null;
  checks: Check[];
  llm_judge_criteria: string | null;
  tags: string[];
  status: EvalCaseStatus;
  created_at: string;
  updated_at: string;
}

export interface EvalRun {
  id: string;
  agent_id: string;
  trigger: EvalRunTrigger;
  status: EvalRunStatus;
  summary: {
    total?: number;
    passed?: number;
    failed?: number;
    errored?: number;
    error_breakdown?: Record<string, number>;
  };
  started_at: string;
  completed_at: string | null;
}

export interface EvalResult {
  id: string;
  run_id: string;
  case_id: string;
  session_id: string | null;
  verdict: EvalVerdict;
  code_checks: Record<string, boolean>;
  llm_judge: { verdict: string; reasoning: string } | null;
  error_type: ErrorType | null;
  steps_taken: Array<{ order: number; action: string; target?: string }>;
  duration_ms: number | null;
  screenshots: string[];
}

// === Chat Messages (for session persistence) ===

export interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'system' | 'finding';
  content: string;
  timestamp: number;
}

export interface Task {
  id: string;
  session_id: string;
  agent_id: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  success: boolean | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export type StepType = 'thought' | 'action' | 'screenshot' | 'navigation' | 'finding' | 'error';

export interface ExecutionStep {
  id: string;
  task_id: string;
  step_order: number;
  step_type: StepType;
  content: string | null;
  target: string | null;
  screenshot_url: string | null;
  duration_ms: number | null;
  created_at: string;
}
