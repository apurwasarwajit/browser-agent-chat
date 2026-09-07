import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import 'dotenv/config';

import agentsRouter from './routes/agents.js';
import findingsRouter from './routes/findings.js';
import memoryRouter from './routes/memory.js';
import suggestionsRouter from './routes/suggestions.js';
import evalsRouter from './routes/evals.js';
import mapRouter from './routes/map.js';
import tracesRouter from './routes/traces.js';
import observabilityRouter from './routes/observability.js';
import vaultRouter, { agentCredentialsRouter } from './routes/vault.js';
import { executeTask, executeExplore, handleLoginDetection } from './agent.js';
import { pendingCredentialRequests } from './vault.js';
import { getAgent, createSession, createTask, updateTask, getTaskClusterByTask } from './db.js';
import { isSupabaseEnabled, verifyToken } from './supabase.js';
import * as sessionManager from './sessionManager.js';
import * as redisStore from './redisStore.js';
import * as browserManager from './browserManager.js';
import { createHeyGenToken, isHeyGenEnabled } from './heygen.js';
import { initLangfuse, shutdownLangfuse, isLangfuseEnabled } from './langfuse.js';
import type { ClientMessage, ServerMessage, ChatMessage } from './types.js';
import feedbackRouter from './routes/feedback.js';
import { processFeedback } from './learning/pipeline.js';
import { MIN_CLUSTER_RUNS } from './learning/extraction.js';
import { initLearningJobs } from './learning/jobs.js';

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Health check
app.get('/health', async (_req, res) => {
  const sessions = await sessionManager.listActiveSessions();
  const redisOk = redisStore.getRedis()?.status === 'ready';
  res.json({
    status: 'ok',
    supabase: isSupabaseEnabled(),
    heygenEnabled: isHeyGenEnabled(),
    langfuseEnabled: isLangfuseEnabled(),
    redis: redisOk,
    activeSessions: sessions.length,
  });
});

// HeyGen token endpoint
app.post('/api/heygen/token', async (_req, res) => {
  try {
    if (!isHeyGenEnabled()) {
      res.status(503).json({ error: 'HeyGen is not configured' });
      return;
    }
    const tokenData = await createHeyGenToken();
    res.json(tokenData);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate HeyGen token';
    res.status(500).json({ error: message });
  }
});

// REST API routes
app.use('/api/agents', agentsRouter);
app.use('/api/agents/:id/findings', findingsRouter);
app.use('/api/agents/:id/memory', memoryRouter);
app.use('/api/agents/:id/suggestions', suggestionsRouter);
app.use('/api/agents/:id/evals', evalsRouter);
app.use('/api/agents/:id/map', mapRouter);
app.use('/api/agents/:id/feedback', feedbackRouter);
app.use('/api/agents/:id/traces', tracesRouter);
app.use('/api/observability', observabilityRouter);
app.use('/api/vault', vaultRouter);
app.use('/api/agents/:id/credentials', agentCredentialsRouter);

// WebSocket server
const WS_AUTH_PROTOCOL = 'authorization';
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: protocols => protocols.has(WS_AUTH_PROTOCOL) ? WS_AUTH_PROTOCOL : false,
});

server.on('upgrade', async (request, socket, head) => {
  const requestedProtocols = request.headers['sec-websocket-protocol']
    ?.split(',')
    .map(protocol => protocol.trim());
  const token = requestedProtocols?.[0] === WS_AUTH_PROTOCOL ? requestedProtocols[1] : undefined;

  try {
    if (!token) throw new Error('Missing token');
    const user = await verifyToken(token);
    if (socket.destroyed) return;

    wss.handleUpgrade(request, socket, head, ws => {
      clientUserIds.set(ws, user.id);
      wss.emit('connection', ws, request);
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

// Track which agent each client is associated with
const clientAgents = new Map<WebSocket, string>();

// Track which user each client is associated with
const clientUserIds = new Map<WebSocket, string>();

// Track active tasks per agent
const activeTasks = new Map<string, { taskId: string; stepCount: number; startedAt: number; prompt: string }>();
const STEP_EVENT_TYPES = new Set(['thought', 'action', 'nav']);

// Count broadcast events during active tasks
sessionManager.onBroadcast((agentId, msg) => {
  if (STEP_EVENT_TYPES.has(msg.type)) {
    const activeTask = activeTasks.get(agentId);
    if (activeTask) activeTask.stepCount++;
  }
});

// Register beforeEvict hook for active task cleanup
sessionManager.setBeforeEvictHook(async (agentId: string) => {
  const taskEntry = activeTasks.get(agentId);
  if (taskEntry) {
    const agent = sessionManager.getAgent(agentId);
    if (agent) {
      try { await agent.close(); } catch { /* agent may already be closed */ }
    }
    try {
      await updateTask(taskEntry.taskId, { status: 'cancelled', completed_at: new Date().toISOString() });
    } catch { /* best effort */ }
    activeTasks.delete(agentId);
  }
});

// Broadcast a ServerMessage to all WebSocket clients connected to an agent.
// Used by eval routes and any future server-initiated push.
export function broadcastToAgent(agentId: string, msg: ServerMessage): void {
  for (const [client, aid] of clientAgents) {
    if (aid === agentId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  }
}

function makeChatMessage(type: ChatMessage['type'], content: string): ChatMessage {
  return { id: crypto.randomUUID(), type, content, timestamp: Date.now() };
}

async function getOwnedAgent(ws: WebSocket, agentId: string) {
  const userId = clientUserIds.get(ws);
  if (!userId) return null;

  const agent = await getAgent(agentId);
  return agent?.user_id === userId ? agent : null;
}

function sendAccessDenied(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: 'error', message: 'Agent not found or access denied' } as ServerMessage));
}

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');

  ws.on('message', async (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    console.log('WS message:', msg.type, JSON.stringify(msg).slice(0, 200));

    if (msg.type === 'ping') {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      const agentId = clientAgents.get(ws);
      if (agentId) {
        const agent = await getOwnedAgent(ws, agentId);
        if (agent) redisStore.updateLastActivity(agentId);
      }
      return;
    }

    if (msg.type === 'start') {
      console.log('[START] Starting agent for:', msg.agentId);

      const agent = await getOwnedAgent(ws, msg.agentId);
      if (!agent) {
        sendAccessDenied(ws);
        return;
      }

      const prevAgentId = clientAgents.get(ws);
      if (prevAgentId && prevAgentId !== msg.agentId) {
        sessionManager.removeClient(prevAgentId, ws);
        clientAgents.delete(ws);
      }

      // Fast path: reattach to existing session
      const hasExisting = await sessionManager.hasSession(msg.agentId);
      if (hasExisting && sessionManager.getAgent(msg.agentId)) {
        console.log('[START] Reattaching to existing session');
        sessionManager.addClient(msg.agentId, ws);
        clientAgents.set(ws, msg.agentId);
        await sessionManager.sendSnapshot(msg.agentId, ws);
        return;
      }

      // Clean up stale Redis data if agent is dead
      if (hasExisting) {
        await sessionManager.destroySession(msg.agentId);
      }

      ws.send(JSON.stringify({ type: 'status', status: 'working' } as ServerMessage));

      // Register client→agent mapping early so viewport messages
      // arriving during async agent creation can find the agent.
      clientAgents.set(ws, msg.agentId);

      try {
        // Ensure capacity before creating new browser
        await sessionManager.ensureCapacity();

        const dbSessionId = await createSession(agent.id);

        const agentSession = await sessionManager.createSession(
          msg.agentId, msg.resumeUrl || agent.url, dbSessionId
        );

        sessionManager.addClient(msg.agentId, ws);

        // Signal new session to client
        ws.send(JSON.stringify({ type: 'session_new', agentId: msg.agentId } as ServerMessage));
        ws.send(JSON.stringify({ type: 'status', status: 'idle' } as ServerMessage));

        // Login detection (async, non-blocking)
        {
          const loginBroadcast = sessionManager.makeBroadcast(msg.agentId);
          const loginPage = agentSession.connector.getHarness().page;
          agentSession.loginDone = handleLoginDetection(loginPage, msg.agentId, agent.user_id, loginBroadcast).catch((err: unknown) => {
            console.error('[LOGIN] Background login error:', err);
          });
        }
      } catch (err) {
        console.error('[START] Error creating agent:', err);
        clientAgents.delete(ws);
        const message = err instanceof Error ? err.message : 'Failed to start agent';
        ws.send(JSON.stringify({ type: 'error', message } as ServerMessage));
        ws.send(JSON.stringify({ type: 'status', status: 'disconnected' } as ServerMessage));
      }

    } else if (msg.type === 'task') {
      const agentId = clientAgents.get(ws);
      if (!agentId) {
        ws.send(JSON.stringify({ type: 'error', message: 'No active session. Start an agent first.' } as ServerMessage));
        return;
      }
      if (!await getOwnedAgent(ws, agentId)) {
        sendAccessDenied(ws);
        return;
      }

      const agentSession = sessionManager.getAgent(agentId);
      if (!agentSession) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session expired. Please restart the agent.' } as ServerMessage));
        return;
      }

      const userMsg = makeChatMessage('user', msg.content);
      redisStore.pushMessage(agentId, userMsg).catch(() => {});

      redisStore.setSession(agentId, { lastTask: msg.content }).catch(() => {});

      // Create task record
      if (agentSession.sessionId) {
        try {
          const taskId = await createTask(agentSession.sessionId, agentId, msg.content);
          activeTasks.set(agentId, { taskId, stepCount: 0, startedAt: Date.now(), prompt: msg.content });
          broadcastToAgent(agentId, { type: 'taskStarted', taskId });
        } catch (err) {
          console.error('[TASK] Failed to create task:', err);
        }
      }

      const baseBroadcast = sessionManager.makeBroadcast(agentId);
      const taskBroadcast = (broadcastMsg: ServerMessage) => {
        // Intercept taskComplete to update task record and enrich with metadata
        if (broadcastMsg.type === 'taskComplete') {
          const activeTask = activeTasks.get(agentId);
          if (activeTask) {
            const enriched: ServerMessage = {
              ...broadcastMsg,
              taskId: activeTask.taskId,
              stepCount: activeTask.stepCount,
              durationMs: Date.now() - activeTask.startedAt,
            };

            const success = broadcastMsg.success;
            updateTask(activeTask.taskId, {
              status: success ? 'completed' : 'failed',
              success,
              completed_at: new Date().toISOString(),
            }).catch(err => console.error('[TASK] Failed to update task:', err));
            // Don't delete from activeTasks yet — need it for feedback
            baseBroadcast(enriched);
            return;
          }
        }
        baseBroadcast(broadcastMsg);
      };
      executeTask(agentSession, msg.content, taskBroadcast);

    } else if (msg.type === 'restart') {
      const agentId = msg.agentId;
      console.log('[RESTART] Restarting agent:', agentId);

      const agent = await getOwnedAgent(ws, agentId);
      if (!agent) {
        sendAccessDenied(ws);
        return;
      }

      // Use beforeEvict hook for task cleanup (same as eviction path)
      await sessionManager.callBeforeEvictHook(agentId);
      await sessionManager.destroySession(agentId);

      await sessionManager.ensureCapacity();

      try {
        clientAgents.set(ws, agentId);

        const dbSessionId = await createSession(agent.id);
        const agentSession = await sessionManager.createSession(agentId, agent.url, dbSessionId);
        sessionManager.addClient(agentId, ws);

        ws.send(JSON.stringify({ type: 'session_new', agentId } as ServerMessage));
        ws.send(JSON.stringify({ type: 'status', status: 'idle' } as ServerMessage));

        // Login detection (async, non-blocking)
        {
          const loginBroadcast = sessionManager.makeBroadcast(agentId);
          const loginPage = agentSession.connector.getHarness().page;
          agentSession.loginDone = handleLoginDetection(loginPage, agentId, agent.user_id, loginBroadcast).catch((err: unknown) => {
            console.error('[LOGIN] Background login error:', err);
          });
        }
      } catch (err) {
        console.error('[RESTART] Error:', err);
        const message = err instanceof Error ? err.message : 'Failed to restart agent';
        ws.send(JSON.stringify({ type: 'error', message } as ServerMessage));
        ws.send(JSON.stringify({ type: 'status', status: 'disconnected' } as ServerMessage));
      }
    } else if (msg.type === 'explore') {
      const agentId = clientAgents.get(ws);
      if (!agentId) {
        ws.send(JSON.stringify({ type: 'error', message: 'No active session. Send start first.' } as ServerMessage));
        return;
      }
      if (agentId !== msg.agentId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Agent ID mismatch with active session.' } as ServerMessage));
        return;
      }

      const agent = await getOwnedAgent(ws, agentId);
      if (!agent) {
        sendAccessDenied(ws);
        return;
      }

      const agentSession = sessionManager.getAgent(agentId);
      if (!agentSession) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session expired.' } as ServerMessage));
        return;
      }

      broadcastToAgent(agentId, { type: 'status', status: 'working' });

      const exploreMsg = makeChatMessage('system', 'Explore & Learn started...');
      redisStore.pushMessage(agentId, exploreMsg).catch(() => {});

      const exploreBroadcast = sessionManager.makeBroadcast(agentId);
      executeExplore(agentSession, agent?.context || null, exploreBroadcast);

    } else if (msg.type === 'taskFeedback') {
      const agentId = clientAgents.get(ws);
      if (!agentId) return;
      if (!await getOwnedAgent(ws, agentId)) {
        sendAccessDenied(ws);
        return;
      }

      const activeTask = activeTasks.get(agentId);
      const agentSession = sessionManager.getAgent(agentId);

      // Only use stored prompt if it matches the feedback task
      const prompt = (activeTask?.taskId === msg.task_id) ? activeTask.prompt : '';
      const broadcastFn = (broadcastMsg: ServerMessage) => broadcastToAgent(agentId, broadcastMsg);

      try {
        await processFeedback(
          agentId,
          msg.task_id,
          agentSession?.sessionId ?? null,
          prompt,
          msg.rating,
          msg.correction ?? null,
          broadcastFn,
        );

        // Query cluster state for the ack
        const cluster = await getTaskClusterByTask(msg.task_id);

        broadcastFn({
          type: 'feedbackAck',
          taskId: msg.task_id,
          rating: msg.rating,
          clustered: !!cluster,
          clusterName: cluster?.task_summary,
          clusterProgress: cluster
            ? { current: cluster.run_count, needed: MIN_CLUSTER_RUNS }
            : undefined,
        });
      } catch (err) {
        console.error('[LEARNING] Feedback processing error:', err);
        // Still ack so the client can show confirmation
        broadcastFn({
          type: 'feedbackAck',
          taskId: msg.task_id,
          rating: msg.rating,
          clustered: false,
        });
      }

      // Clean up if this was the active task
      if (activeTask?.taskId === msg.task_id) {
        activeTasks.delete(agentId);
      }

    } else if (msg.type === 'credential_provided') {
      const agentId = clientAgents.get(ws);
      if (!agentId) return;
      if (!await getOwnedAgent(ws, agentId)) {
        sendAccessDenied(ws);
        return;
      }
      const pending = pendingCredentialRequests.get(agentId);
      if (pending) {
        pending.resolve(msg.credentialId);
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    const agentId = clientAgents.get(ws);
    if (agentId) {
      sessionManager.removeClient(agentId, ws);
      clientAgents.delete(ws);
      // DO NOT delete activeTasks here — task continues running server-side
    }
    clientUserIds.delete(ws);
  });
});

const PORT = parseInt(process.env.PORT || '3001');

async function shutdown(signal: string): Promise<void> {
  console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  wss.close();

  // Mark sessions disconnected (browsers survive)
  await sessionManager.shutdownAll();

  // Flush Langfuse traces
  await shutdownLangfuse();

  // Close Redis
  await redisStore.shutdown();

  console.log('[SHUTDOWN] Complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function startup(): Promise<void> {
  console.log('[STARTUP] Initializing Langfuse...');
  initLangfuse();

  console.log('[STARTUP] Connecting to Redis...');
  redisStore.connect();

  console.log('[STARTUP] Cleaning up orphaned warm browsers...');
  await browserManager.cleanupOrphanedWarm();

  console.log('[STARTUP] Recovering sessions...');
  await sessionManager.recoverAllSessions();

  console.log('[STARTUP] Starting expiry polling...');
  redisStore.pollExpiredSessions(sessionManager.handleExpiry);

  console.log('[STARTUP] Warming browser pool...');
  browserManager.warmUp().catch(err =>
    console.error('[STARTUP] Warm-up error:', err)
  );

  server.listen(PORT, () => {
    console.log(`[STARTUP] Server running on http://localhost:${PORT}`);
    console.log('[STARTUP] WebSocket server ready');
    try {
      initLearningJobs();
    } catch (err) {
      console.error('[STARTUP] Learning jobs init error:', err);
    }
  });
}

startup().catch(err => {
  console.error('[STARTUP] Fatal error:', err);
  process.exit(1);
});
