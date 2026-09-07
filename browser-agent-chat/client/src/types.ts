// === Database Models ===

export type Criticality = 'critical' | 'high' | 'medium' | 'low';
export type FindingType = 'visual' | 'functional' | 'data' | 'ux';
export type FindingStatus = 'new' | 'confirmed' | 'dismissed';
export type AgentStatus = 'idle' | 'working' | 'error' | 'disconnected' | 'crashed' | 'interrupted';

export interface AgentListItem {
  id: string;
  name: string;
  url: string;
  hasCredentials: boolean;
  context: string | null;
  created_at: string;
  updated_at: string;
  findings_count: number;
  last_session_at: string | null;
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

export interface FlowStep {
  order: number;
  description: string;
  url?: string;
}

export interface Checkpoint {
  description: string;
  expected: string;
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
  steps_to_reproduce: { order: number; action: string; target?: string }[];
  expected_behavior: string | null;
  actual_behavior: string | null;
  screenshot_url: string | null;
  status: FindingStatus;
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
}

export interface FlowSuggestionData {
  feature_name: string;
  name: string;
  steps: FlowStep[];
  checkpoints: Checkpoint[];
  criticality: Criticality;
}

export interface BehaviorSuggestionData {
  feature_name: string;
  behavior: string;
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

// === WebSocket Messages ===

export type ClientMessage =
  | { type: 'start'; agentId: string; resumeUrl?: string }
  | { type: 'task'; content: string }
  | { type: 'explore'; agentId: string }
  | { type: 'restart'; agentId: string }
  | { type: 'ping' }
  | { type: 'taskFeedback'; task_id: string; rating: 'positive' | 'negative'; correction?: string }
  | { type: 'action_confirmation'; confirmationId: string; approved: boolean }
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
  | { type: 'patternLearned'; name: string; steps: string[]; success_rate: number; avg_steps: number; runs: number; transition: 'active' | 'dominant' }
  | { type: 'patternStale'; name: string; reason: string }
  | { type: 'feedbackAck'; taskId: string; rating: 'positive' | 'negative'; clustered: boolean; clusterName?: string; clusterProgress?: { current: number; needed: number } }
  | { type: 'credential_needed'; agentId: string; domain: string; strategy: string }
  | { type: 'action_confirmation_required'; confirmationId: string; action: string; target: string; reason: string; origin: string }
  | { type: 'session_evicted'; agentId: string; reason: 'capacity' }
  | { type: 'session_expiring'; remainingSeconds: number }
  | { type: 'session_new'; agentId: string };

// === Chat ===

export interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'system' | 'finding';
  content: string;
  timestamp: number;
  finding?: Finding;
  patternData?: {
    name: string;
    steps: string[];
    successRate: number;
    runs: number;
    transition: 'active' | 'dominant';
    isCelebration: boolean;
  };
}
