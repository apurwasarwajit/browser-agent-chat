import { Langfuse } from 'langfuse';

export interface TraceSummary {
  id: string;
  name: string;
  input: unknown;
  latency: number | null;
  totalCost: number | null;
  status: 'success' | 'error';
  observationCount: number;
  timestamp: string;
  sessionId: string | null;
}

export interface TraceObservation {
  name: string | null;
  startTime: string;
  endTime: string | null;
  duration: number | null;
  model: string | null;
  tokenCount: number | null;
  level: string;
}

export interface TraceDetail {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  latency: number | null;
  totalCost: number | null;
  status: 'success' | 'error';
  timestamp: string;
  observations: TraceObservation[];
}

export interface TracePaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
}

export interface ObservabilitySummary {
  totalTraces: number;
  totalCost: number;
  errorRate: number;
  avgLatency: number;
  p95Latency: number;
}

export interface ObservabilityTrends {
  cost: Record<string, string | number>[];
  traces: Record<string, string | number>[];
  agents: string[];
}

export interface ObservabilityAgentRow {
  agentId: string;
  agentName: string;
  traceCount: number;
  totalCost: number;
  errorRate: number;
  avgLatency: number;
}

function deriveStatus(output: unknown): 'success' | 'error' {
  if (output && typeof output === 'object' && 'success' in output) {
    return (output as { success: boolean }).success ? 'success' : 'error';
  }
  return 'success';
}

let langfuse: Langfuse | null = null;

export function isLangfuseEnabled(): boolean {
  return langfuse !== null;
}

export function getLangfuse(): Langfuse | null {
  return langfuse;
}

export function initLangfuse(): void {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    console.log('[LANGFUSE] Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY — tracing disabled');
    return;
  }

  langfuse = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL || 'http://localhost:3000',
  });

  console.log('[LANGFUSE] Tracing enabled');
}

export async function shutdownLangfuse(): Promise<void> {
  if (langfuse) {
    await langfuse.shutdownAsync();
    console.log('[LANGFUSE] Flushed and shut down');
  }
}

export async function fetchAgentTraces(
  agentId: string,
  page = 1,
  limit = 50
): Promise<{ traces: TraceSummary[]; meta: TracePaginationMeta }> {
  if (!langfuse) throw new Error('Langfuse not initialized');

  const result = await langfuse.api.traceList({
    tags: [`agent:${agentId}`],
    page,
    limit,
    orderBy: 'timestamp.desc',
  });

  const traces: TraceSummary[] = result.data.map(t => ({
    id: t.id,
    name: t.name ?? 'unnamed',
    input: t.input,
    latency: t.latency ?? null,
    totalCost: t.totalCost ?? null,
    status: deriveStatus(t.output),
    observationCount: t.observations?.length ?? 0,
    timestamp: t.timestamp,
    sessionId: t.sessionId ?? null,
  }));

  return {
    traces,
    meta: {
      page: result.meta.page,
      limit: result.meta.limit,
      totalItems: result.meta.totalItems,
      totalPages: result.meta.totalPages,
    },
  };
}

export async function fetchTraceDetail(traceId: string, agentId: string): Promise<TraceDetail | null> {
  if (!langfuse) throw new Error('Langfuse not initialized');

  const t = await langfuse.api.traceGet(traceId);
  if (!t.tags?.includes(`agent:${agentId}`)) return null;

  const observations: TraceObservation[] = (t.observations ?? []).map(obs => {
    const startMs = new Date(obs.startTime).getTime();
    const endMs = obs.endTime ? new Date(obs.endTime).getTime() : null;
    const duration = endMs !== null ? (endMs - startMs) / 1000 : null;

    let tokenCount: number | null = null;
    if (obs.usage) {
      const u = obs.usage as { total?: number; input?: number; output?: number };
      tokenCount = u.total ?? (((u.input ?? 0) + (u.output ?? 0)) || null);
    }

    return {
      name: obs.name ?? null,
      startTime: obs.startTime,
      endTime: obs.endTime ?? null,
      duration,
      model: obs.model ?? null,
      tokenCount,
      level: obs.level ?? 'DEFAULT',
    };
  });

  // Sort observations by startTime
  observations.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

  return {
    id: t.id,
    name: t.name ?? 'unnamed',
    input: t.input,
    output: t.output,
    latency: t.latency ?? null,
    totalCost: t.totalCost ?? null,
    status: deriveStatus(t.output),
    timestamp: t.timestamp,
    observations,
  };
}

export async function fetchObservabilitySummary(
  from: string,
  to: string
): Promise<ObservabilitySummary> {
  if (!langfuse) throw new Error('Langfuse not initialized');

  // Primary metrics query
  const query = JSON.stringify({
    view: 'traces',
    metrics: [
      { measure: 'count', aggregation: 'count' },
      { measure: 'latency', aggregation: 'avg' },
      { measure: 'latency', aggregation: 'p95' },
      { measure: 'totalCost', aggregation: 'sum' },
    ],
    fromTimestamp: from,
    toTimestamp: to,
  });

  const result = await langfuse.api.metricsMetrics({ query });
  const row = result.data?.[0] ?? {};

  const totalTraces = Number(row.count_count ?? row.count ?? 0);
  const avgLatency = Number(row.latency_avg ?? row.avg_latency ?? 0);
  const p95Latency = Number(row.latency_p95 ?? row.p95_latency ?? 0);
  const totalCost = Number(row.totalCost_sum ?? row.sum_totalCost ?? row.total_cost ?? 0);

  // Derive error rate from raw traces (metricsMetrics doesn't support status filtering reliably)
  let errorRate = 0;
  if (totalTraces > 0) {
    try {
      let errorCount = 0;
      let page = 1;
      let hasMore = true;
      let totalChecked = 0;

      const MAX_PAGES = 10; // Cap at 1000 traces to avoid runaway API calls
      while (hasMore && page <= MAX_PAGES) {
        const batch = await langfuse.api.traceList({
          page,
          limit: 100,
          fromTimestamp: from,
          toTimestamp: to,
          orderBy: 'timestamp.desc',
        });

        for (const t of batch.data) {
          if (deriveStatus(t.output) === 'error') errorCount++;
        }
        totalChecked += batch.data.length;
        hasMore = batch.data.length === 100 && totalChecked < totalTraces;
        page++;
      }

      errorRate = totalChecked > 0 ? errorCount / totalChecked : 0;
    } catch (err) {
      console.error('[OBSERVABILITY] Error rate derivation failed:', err);
    }
  }

  return { totalTraces, totalCost, errorRate, avgLatency, p95Latency };
}

export async function fetchObservabilityTrends(
  from: string,
  to: string,
  agentNames: Map<string, string>  // agentId → agentName
): Promise<ObservabilityTrends> {
  if (!langfuse) throw new Error('Langfuse not initialized');

  const daysDiff = (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24);
  const granularity = daysDiff <= 30 ? 'day' : 'week';

  // Try grouped query by tags first
  const costData: Record<string, string | number>[] = [];
  const traceData: Record<string, string | number>[] = [];
  const agentList: string[] = [];

  try {
    // Attempt grouped call with tags dimension
    const groupedQuery = JSON.stringify({
      view: 'traces',
      metrics: [
        { measure: 'totalCost', aggregation: 'sum' },
        { measure: 'count', aggregation: 'count' },
      ],
      dimensions: [{ field: 'tags' }],
      timeDimension: { granularity },
      fromTimestamp: from,
      toTimestamp: to,
    });

    const result = await langfuse.api.metricsMetrics({ query: groupedQuery });

    if (result.data && result.data.length > 0) {
      // Parse grouped results
      const dateMap = new Map<string, Record<string, number>>();
      const costDateMap = new Map<string, Record<string, number>>();
      const agentSet = new Set<string>();

      for (const row of result.data) {
        const tag = String(row.tags ?? row.tag ?? '');
        if (!tag.startsWith('agent:')) continue;

        const agentId = tag.replace('agent:', '');
        const name = agentNames.get(agentId) ?? agentId;
        agentSet.add(name);

        const date = String(row.date ?? row.time ?? row.timestamp ?? '').slice(0, 10);
        if (!date) continue;

        if (!costDateMap.has(date)) costDateMap.set(date, {});
        costDateMap.get(date)![name] = Number(row.totalCost_sum ?? row.sum_totalCost ?? 0);

        if (!dateMap.has(date)) dateMap.set(date, {});
        dateMap.get(date)![name] = Number(row.count_count ?? row.count ?? 0);
      }

      agentList.push(...agentSet);
      const sortedDates = [...costDateMap.keys()].sort();

      for (const date of sortedDates) {
        costData.push({ date, ...costDateMap.get(date) });
        traceData.push({ date, ...dateMap.get(date) });
      }

      return { cost: costData, traces: traceData, agents: agentList };
    }
  } catch {
    // Grouped tags dimension not supported, fall back to per-agent calls
  }

  // Fallback: individual metrics calls per agent
  const agentSet = new Set<string>();
  const costDateMap = new Map<string, Record<string, number>>();
  const traceDateMap = new Map<string, Record<string, number>>();

  for (const [agentId, agentName] of agentNames) {
    agentSet.add(agentName);
    try {
      const perAgentQuery = JSON.stringify({
        view: 'traces',
        metrics: [
          { measure: 'totalCost', aggregation: 'sum' },
          { measure: 'count', aggregation: 'count' },
        ],
        timeDimension: { granularity },
        filters: [{ column: 'tags', operator: 'any of', value: [`agent:${agentId}`] }],
        fromTimestamp: from,
        toTimestamp: to,
      });

      const result = await langfuse.api.metricsMetrics({ query: perAgentQuery });

      for (const row of result.data ?? []) {
        const date = String(row.date ?? row.time ?? row.timestamp ?? '').slice(0, 10);
        if (!date) continue;

        if (!costDateMap.has(date)) costDateMap.set(date, {});
        costDateMap.get(date)![agentName] = Number(row.totalCost_sum ?? row.sum_totalCost ?? 0);

        if (!traceDateMap.has(date)) traceDateMap.set(date, {});
        traceDateMap.get(date)![agentName] = Number(row.count_count ?? row.count ?? 0);
      }
    } catch (err) {
      console.error(`[OBSERVABILITY] Trends fetch failed for agent ${agentId}:`, err);
    }
  }

  agentList.push(...agentSet);
  const sortedDates = [...costDateMap.keys()].sort();

  for (const date of sortedDates) {
    costData.push({ date, ...costDateMap.get(date) });
    traceData.push({ date, ...traceDateMap.get(date) });
  }

  return { cost: costData, traces: traceData, agents: agentList };
}

export async function fetchObservabilityAgents(
  from: string,
  to: string,
  agentNames: Map<string, string>  // agentId → agentName
): Promise<ObservabilityAgentRow[]> {
  if (!langfuse) throw new Error('Langfuse not initialized');

  const rows: ObservabilityAgentRow[] = [];

  // Per-agent metrics (fallback-first approach since tags dimension is unreliable)
  for (const [agentId, agentName] of agentNames) {
    try {
      const query = JSON.stringify({
        view: 'traces',
        metrics: [
          { measure: 'count', aggregation: 'count' },
          { measure: 'totalCost', aggregation: 'sum' },
          { measure: 'latency', aggregation: 'avg' },
        ],
        filters: [{ column: 'tags', operator: 'any of', value: [`agent:${agentId}`] }],
        fromTimestamp: from,
        toTimestamp: to,
      });

      const result = await langfuse.api.metricsMetrics({ query });
      const data = result.data?.[0] ?? {};

      const traceCount = Number(data.count_count ?? data.count ?? 0);
      const totalCost = Number(data.totalCost_sum ?? data.sum_totalCost ?? 0);
      const avgLatency = Number(data.latency_avg ?? data.avg_latency ?? 0);

      // Derive error rate from raw traces
      let errorRate = 0;
      if (traceCount > 0) {
        try {
          const traceResult = await langfuse.api.traceList({
            tags: [`agent:${agentId}`],
            page: 1,
            limit: 100,
            fromTimestamp: from,
            toTimestamp: to,
            orderBy: 'timestamp.desc',
          });

          let errorCount = 0;
          for (const t of traceResult.data) {
            if (deriveStatus(t.output) === 'error') errorCount++;
          }
          errorRate = traceResult.data.length > 0 ? errorCount / traceResult.data.length : 0;
        } catch {
          // Skip error rate if raw fetch fails
        }
      }

      if (traceCount > 0) {
        rows.push({ agentId, agentName, traceCount, totalCost, errorRate, avgLatency });
      }
    } catch (err) {
      console.error(`[OBSERVABILITY] Agent metrics failed for ${agentId}:`, err);
    }
  }

  return rows;
}
