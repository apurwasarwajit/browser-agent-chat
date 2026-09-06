import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { ClientMessage, ServerMessage, AgentStatus, ChatMessage, Finding, Suggestion } from '../types';
import { supabase } from '../lib/supabase';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';
const HEARTBEAT_INTERVAL = 30_000;

interface FeedbackAckData {
  taskId: string;
  rating: 'positive' | 'negative';
  clustered: boolean;
  clusterName?: string;
  clusterProgress?: { current: number; needed: number };
}

interface WebSocketState {
  connected: boolean;
  status: AgentStatus;
  screenshot: string | null;
  currentUrl: string | null;
  messages: ChatMessage[];
  findings: Finding[];
  findingsCount: number;
  pendingSuggestionCount: number;
  activeAgentId: string | null;
  activeTaskId: string | null;
  lastCompletedTask: { taskId: string; success: boolean; stepCount: number; durationMs: number } | null;
  feedbackAck: FeedbackAckData | null;
  startAgent: (agentId: string, isReconnect?: boolean) => void;
  sendTask: (content: string) => void;
  sendRestart: (agentId: string) => void;
  explore: (agentId: string) => void;
  sendFeedback: (taskId: string, rating: 'positive' | 'negative', correction?: string) => void;
  resetSuggestionCount: () => void;
  decrementSuggestionCount: () => void;
  pendingCredentialRequest: { agentId: string; domain: string; strategy: string } | null;
  sendCredentialProvided: (credentialId: string) => void;
  sessionWarning: string | null;
  sessionEvicted: boolean;
}

const WebSocketContext = createContext<WebSocketState | null>(null);

export function useWS(): WebSocketState {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWS must be used within WebSocketProvider');
  return ctx;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const lastScreenshotTimeRef = useRef<number>(0);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<AgentStatus>('disconnected');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [pendingSuggestionCount, setPendingSuggestionCount] = useState(0);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [lastCompletedTask, setLastCompletedTask] = useState<{
    taskId: string;
    success: boolean;
    stepCount: number;
    durationMs: number;
  } | null>(null);
  const [pendingCredentialRequest, setPendingCredentialRequest] = useState<{ agentId: string; domain: string; strategy: string } | null>(null);
  const [feedbackAck, setFeedbackAck] = useState<FeedbackAckData | null>(null);
  const [sessionWarning, setSessionWarning] = useState<string | null>(null);
  const [sessionEvicted, setSessionEvicted] = useState<boolean>(false);

  // Stable ref for the active agent so message handlers don't get stale closures
  const activeAgentRef = useRef<string | null>(null);
  const pendingTasksRef = useRef<string[]>([]);

  // Track the last URL so we can resume at the same page after reconnect
  const lastUrlRef = useRef<string | null>(null);

  // pendingExploreRef: if set, send explore once we reach 'idle' status after auto-start
  const pendingExploreRef = useRef<string | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    const ready = wsRef.current?.readyState;
    console.log('[WS] send', msg.type, 'readyState:', ready);
    if (ready === WebSocket.OPEN) {
      wsRef.current!.send(JSON.stringify(msg));
    } else {
      console.warn('[WS] send DROPPED — socket not open, readyState:', ready);
    }
  }, []);

  const addMessage = useCallback((type: ChatMessage['type'], content: string, finding?: Finding) => {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      type,
      content,
      timestamp: Date.now(),
      finding,
    }]);
  }, []);

  const handleMessage = useCallback((event: MessageEvent) => {
    let msg: ServerMessage & { type: string; messages?: ChatMessage[] };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'thought':
        addMessage('agent', (msg as any).content);
        break;
      case 'action': {
        const a = msg as any;
        addMessage('agent', `Action: ${a.action}${a.target ? ` → ${a.target}` : ''}`);
        break;
      }
      case 'screenshot': {
        // Throttle: skip frames if last update was < 100ms ago (~10fps max)
        const now = Date.now();
        if (now - lastScreenshotTimeRef.current < 100) break;
        lastScreenshotTimeRef.current = now;
        setScreenshot(`data:image/jpeg;base64,${(msg as any).data}`);
        break;
      }
      case 'status':
        setStatus((msg as any).status);
        // Drain pending tasks when session is ready
        if ((msg as any).status === 'idle' && pendingTasksRef.current.length > 0) {
          const pending = pendingTasksRef.current;
          pendingTasksRef.current = [];
          for (const content of pending) {
            send({ type: 'task', content });
          }
        }
        // IMPORTANT: Do NOT clear activeAgentId/activeAgentRef on server-sent 'disconnected'
        // The always-connected model keeps activeAgentRef set so reconnect can re-establish
        break;
      case 'nav':
        setCurrentUrl((msg as any).url);
        lastUrlRef.current = (msg as any).url;
        break;
      case 'error':
        addMessage('system', `Error: ${(msg as any).message}`);
        break;
      case 'taskStarted':
        setActiveTaskId((msg as any).taskId);
        setLastCompletedTask(null);  // Clear previous card
        setFeedbackAck(null);        // Prune ack
        break;
      case 'taskComplete': {
        const taskId = (msg as any).taskId ?? activeTaskId ?? '';
        const stepCount = (msg as any).stepCount ?? 0;
        const durationMs = (msg as any).durationMs ?? 0;
        setLastCompletedTask({ taskId, success: (msg as any).success, stepCount, durationMs });
        setActiveTaskId(null);
        // Don't add system message here — TaskCompletionCard handles display
        break;
      }
      case 'finding': {
        const finding = (msg as any).finding as Finding;
        setFindings(prev => [...prev, finding]);
        addMessage('finding', finding.title, finding);
        break;
      }
      case 'suggestion': {
        const suggestion = (msg as any).suggestion as Suggestion;
        setPendingSuggestionCount(c => c + 1);
        const typeLabel = suggestion.type === 'feature' ? 'feature' : suggestion.type === 'flow' ? 'flow' : 'behavior';
        const name = 'name' in suggestion.data ? (suggestion.data as any).name : (suggestion.data as any).feature_name;
        addMessage('system', `💡 Learned: "${name}" ${typeLabel}`);
        break;
      }
      case 'sessionRestore': {
        // Server sent full message history on reconnect
        const restored = (msg as any).messages as ChatMessage[];
        if (restored && restored.length > 0) {
          setMessages(restored);
        }
        break;
      }
      case 'metrics': {
        const m = (msg as any).metrics;
        const summary = m.steps
          .map((s: any) => `${s.name}: ${s.duration}ms`)
          .join(' | ');
        addMessage('system', `Startup: ${m.total}ms (${summary})`);
        break;
      }
      case 'patternLearned': {
        const pl = msg as any;
        const agentId = activeAgentRef.current;

        // Check if this is the first pattern (localStorage)
        const lsKey = agentId ? `learning:firstPattern:${agentId}` : null;
        let isCelebration = false;
        if (pl.transition === 'active' && lsKey && !localStorage.getItem(lsKey)) {
          isCelebration = true;
          localStorage.setItem(lsKey, 'true');
        }

        // Add as a special message type so it renders inline in the chat flow
        const patternMsg: ChatMessage = {
          id: crypto.randomUUID(),
          type: 'system',
          content: '__patternLearned__',  // Sentinel — ChatPanel renders PatternLearnedCard instead of text
          timestamp: Date.now(),
          patternData: {
            name: pl.name,
            steps: pl.steps,
            successRate: pl.success_rate,
            runs: pl.runs,
            transition: pl.transition,
            isCelebration,
          },
        };
        setMessages(prev => [...prev, patternMsg]);
        break;
      }
      case 'patternStale': {
        const ps = msg as any;
        addMessage('system', `Pattern stale: "${ps.name}" — ${ps.reason}`);
        break;
      }
      case 'feedbackAck': {
        const ack = msg as any;
        setFeedbackAck({
          taskId: ack.taskId,
          rating: ack.rating,
          clustered: ack.clustered,
          clusterName: ack.clusterName,
          clusterProgress: ack.clusterProgress,
        });
        break;
      }
      case 'pong':
        // Heartbeat response — no action needed
        break;
      case 'sessionCrashed':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'system',
          content: 'Browser session crashed. Please restart the agent to continue.',
          timestamp: Date.now(),
        }]);
        setStatus('disconnected');
        activeAgentRef.current = null;
        setActiveAgentId(null);
        setPendingCredentialRequest(null);
        break;
      case 'taskInterrupted':
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          type: 'system',
          content: `Server restarted while running a task. Your browser session was preserved. Previous task: "${(msg as any).task}"`,
          timestamp: Date.now(),
        }]);
        // Status stays as-is (likely 'idle' from the recovered session snapshot)
        break;
      case 'credential_needed': {
        const m = msg as { type: 'credential_needed'; agentId: string; domain: string; strategy: string };
        setPendingCredentialRequest({ agentId: m.agentId, domain: m.domain, strategy: m.strategy });
        break;
      }
      case 'session_evicted':
        setStatus('disconnected');
        setSessionEvicted(true);
        activeAgentRef.current = null;
        break;
      case 'session_expiring':
        setSessionWarning(`Session expires in ${Math.floor((msg as any).remainingSeconds / 60)} minutes.`);
        break;
      case 'session_new':
        // Reset all session-bound state for fresh session
        setMessages([]);
        setScreenshot(null);
        setCurrentUrl(null);
        setFindings([]);
        setPendingSuggestionCount(0);
        setActiveTaskId(null);
        setLastCompletedTask(null);
        setFeedbackAck(null);
        setPendingCredentialRequest(null);
        setSessionWarning(null);
        setSessionEvicted(false);
        break;
    }
  }, [addMessage, send]);

  const startAgent = useCallback((agentId: string, isReconnect = false) => {
    // Clear stale state if switching agents
    if (activeAgentRef.current && activeAgentRef.current !== agentId) {
      setMessages([]);
      setScreenshot(null);
      setCurrentUrl(null);
      setFindings([]);
      setPendingSuggestionCount(0);
      setActiveTaskId(null);
      setLastCompletedTask(null);
      setFeedbackAck(null);
      lastUrlRef.current = null;
    }

    activeAgentRef.current = agentId;
    setActiveAgentId(agentId);

    if (!isReconnect) {
      setStatus('working');
    }

    send({ type: 'start', agentId, resumeUrl: lastUrlRef.current || undefined });
  }, [send]);

  // Use a ref so connect's onopen can call the latest startAgent without a dep cycle
  const startAgentRef = useRef(startAgent);
  startAgentRef.current = startAgent;

  const connect = useCallback(async () => {
    if (connectingRef.current || wsRef.current?.readyState === WebSocket.CONNECTING || wsRef.current?.readyState === WebSocket.OPEN) return;
    connectingRef.current = true;

    let ws: WebSocket;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const protocols = session?.access_token ? ['bearer', session.access_token] : undefined;
      ws = new WebSocket(WS_URL, protocols);
    } catch (error) {
      console.error('[WS] Failed to initialize authenticated connection:', error);
      connectingRef.current = false;
      reconnectTimeoutRef.current = setTimeout(() => void connect(), 3000);
      return;
    }
    connectingRef.current = false;

    ws.onopen = () => {
      setConnected(true);

      // Start heartbeat
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, HEARTBEAT_INTERVAL);

      // Auto-reconnect: re-establish session
      if (activeAgentRef.current) {
        startAgentRef.current(activeAgentRef.current, /* isReconnect */ true);
      }
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      setConnected(false);
      setPendingCredentialRequest(null);
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      // Reconnect with backoff
      reconnectTimeoutRef.current = setTimeout(() => void connect(), 3000);
    };

    ws.onerror = () => ws.close();

    wsRef.current = ws;
  }, [handleMessage]);

  // Connect on mount, cleanup on unmount
  useEffect(() => {
    void connect();

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const sendTask = useCallback((content: string) => {
    addMessage('user', content);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send({ type: 'task', content });
    } else {
      pendingTasksRef.current.push(content);
    }
  }, [send, addMessage]);

  const sendRestart = useCallback((agentId: string) => {
    send({ type: 'restart', agentId });
    setStatus('working');
  }, [send]);

  const explore = useCallback((agentId: string) => {
    setStatus('working');

    if (!activeAgentRef.current || activeAgentRef.current !== agentId) {
      // Auto-start path — defer explore message until session is ready
      pendingExploreRef.current = agentId;
      setActiveAgentId(agentId);
      activeAgentRef.current = agentId;
      const resumeUrl = lastUrlRef.current || undefined;
      send({ type: 'start', agentId, resumeUrl });
    } else {
      addMessage('system', 'Explore & Learn started...');
      send({ type: 'explore', agentId });
    }
  }, [send, addMessage]);

  // When agent reaches idle after a pending explore (auto-start), fire the explore
  useEffect(() => {
    if (status === 'idle' && pendingExploreRef.current) {
      const agentId = pendingExploreRef.current;
      pendingExploreRef.current = null;
      addMessage('system', 'Explore & Learn started...');
      send({ type: 'explore', agentId });
    }
  }, [status, send, addMessage]);

  const sendFeedback = useCallback((taskId: string, rating: 'positive' | 'negative', correction?: string) => {
    send({ type: 'taskFeedback', task_id: taskId, rating, correction });
    // Do NOT clear lastCompletedTask here — card stays visible for feedbackAck
  }, [send]);

  const resetSuggestionCount = useCallback(() => {
    setPendingSuggestionCount(0);
  }, []);

  const decrementSuggestionCount = useCallback(() => {
    setPendingSuggestionCount(c => Math.max(0, c - 1));
  }, []);

  const sendCredentialProvided = useCallback((credentialId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'credential_provided', credentialId }));
    }
    setPendingCredentialRequest(null);
  }, []);

  const value: WebSocketState = {
    connected,
    status,
    screenshot,
    currentUrl,
    messages,
    findings,
    findingsCount: findings.length,
    pendingSuggestionCount,
    activeAgentId,
    activeTaskId,
    lastCompletedTask,
    startAgent,
    sendTask,
    sendRestart,
    explore,
    sendFeedback,
    resetSuggestionCount,
    decrementSuggestionCount,
    feedbackAck,
    pendingCredentialRequest,
    sendCredentialProvided,
    sessionWarning,
    sessionEvicted,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}
