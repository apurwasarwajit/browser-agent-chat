import { supabase, isSupabaseEnabled } from './supabase.js';
import { normalizeUrl } from './nav-graph.js';
import { isDuplicate } from './entity-resolver.js';
import type {
  Agent, Feature, Flow, Finding, Session, Message,
  EncryptedCredentials, Criticality, FindingType, FindingStatus, ReproStep,
  Suggestion, FeatureSuggestionData, FlowSuggestionData, BehaviorSuggestionData, FlowStep, Checkpoint,
  ChatMessage,
  EvalCase, EvalRun, EvalResult, EvalRunTrigger, EvalRunStatus,
  Task, StepType, ExecutionStep,
  TaskFeedback, LearningPoolEntry, TaskCluster, LearnedPattern,
  FeedbackRating, PatternState
} from './types.js';

// === Agents ===

export async function createAgent(
  userId: string, name: string, url: string,
  credentials: EncryptedCredentials | null, context: string | null
): Promise<Agent | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('agents')
    .insert({ user_id: userId, name, url, credentials, context })
    .select()
    .single();
  if (error) { console.error('createAgent error:', error); return null; }
  return data;
}

export async function getAgent(agentId: string, userId?: string): Promise<Agent | null> {
  if (!isSupabaseEnabled()) return null;
  let query = supabase!
    .from('agents')
    .select('*')
    .eq('id', agentId);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query.single();
  if (error) return null;
  return data;
}

export async function listAgents(userId: string): Promise<Agent[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) { console.error('listAgents error:', error); return []; }
  return data ?? [];
}

export async function updateAgent(
  agentId: string, updates: Partial<Pick<Agent, 'name' | 'url' | 'credentials' | 'context'>>
): Promise<Agent | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('agents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', agentId)
    .select()
    .single();
  if (error) { console.error('updateAgent error:', error); return null; }
  return data;
}

export async function deleteAgent(agentId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!.from('agents').delete().eq('id', agentId);
  return !error;
}

export async function getAgentListStats(agentIds: string[]): Promise<Map<string, { findingsCount: number; lastSessionAt: string | null }>> {
  const result = new Map<string, { findingsCount: number; lastSessionAt: string | null }>();
  agentIds.forEach(id => result.set(id, { findingsCount: 0, lastSessionAt: null }));

  if (!isSupabaseEnabled() || agentIds.length === 0) return result;

  // Fetch findings counts (parallel queries — Supabase JS doesn't support GROUP BY natively)
  await Promise.all(agentIds.map(async id => {
    const { count } = await supabase!
      .from('findings')
      .select('*', { count: 'exact', head: true })
      .eq('agent_id', id)
      .neq('status', 'dismissed');
    const entry = result.get(id);
    if (entry) entry.findingsCount = count ?? 0;
  }));

  // Fetch last session timestamps (single query for all agents)
  const { data: sessionData } = await supabase!
    .from('sessions')
    .select('agent_id, started_at')
    .in('agent_id', agentIds)
    .order('started_at', { ascending: false });
  if (sessionData) {
    for (const row of sessionData) {
      const entry = result.get(row.agent_id);
      // First row per agent_id is the most recent (ordered desc)
      if (entry && entry.lastSessionAt === null) {
        entry.lastSessionAt = row.started_at;
      }
    }
  }

  return result;
}

// === Memory Features ===

export async function listFeatures(agentId: string): Promise<Feature[]> {
  if (!isSupabaseEnabled()) return [];
  const { data: features, error } = await supabase!
    .from('memory_features')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: true });
  if (error || !features) return [];

  // Attach flows to each feature
  const { data: flows } = await supabase!
    .from('memory_flows')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: true });

  return features.map(f => ({
    ...f,
    flows: (flows ?? []).filter(fl => fl.feature_id === f.id),
  }));
}

export async function createFeature(
  agentId: string, name: string, description: string | null,
  criticality: Criticality, expectedBehaviors: string[]
): Promise<Feature | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('memory_features')
    .insert({ agent_id: agentId, name, description, criticality, expected_behaviors: expectedBehaviors })
    .select()
    .single();
  if (error) { console.error('createFeature error:', error); return null; }
  return { ...data, flows: [] };
}

export async function updateFeature(
  featureId: string, updates: Partial<Pick<Feature, 'name' | 'description' | 'criticality' | 'expected_behaviors'>>
): Promise<Feature | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('memory_features')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', featureId)
    .select()
    .single();
  if (error) { console.error('updateFeature error:', error); return null; }
  return data;
}

export async function deleteFeature(featureId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!.from('memory_features').delete().eq('id', featureId);
  return !error;
}

export async function findFeatureByName(
  agentId: string,
  name: string
): Promise<Feature | null> {
  if (!isSupabaseEnabled()) return null;
  // Escape SQL wildcards for ilike (case-insensitive exact match)
  const escaped = name.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const { data, error } = await supabase!
    .from('memory_features')
    .select('*')
    .eq('agent_id', agentId)
    .ilike('name', escaped)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// === Memory Flows ===

export async function createFlow(
  featureId: string, agentId: string, name: string,
  steps: Flow['steps'], checkpoints: Flow['checkpoints'], criticality: Criticality
): Promise<Flow | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('memory_flows')
    .insert({ feature_id: featureId, agent_id: agentId, name, steps, checkpoints, criticality })
    .select()
    .single();
  if (error) { console.error('createFlow error:', error); return null; }
  return data;
}

export async function updateFlow(
  flowId: string, updates: Partial<Pick<Flow, 'name' | 'steps' | 'checkpoints' | 'criticality'>>
): Promise<Flow | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('memory_flows')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', flowId)
    .select()
    .single();
  if (error) { console.error('updateFlow error:', error); return null; }
  return data;
}

export async function deleteFlow(flowId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!.from('memory_flows').delete().eq('id', flowId);
  return !error;
}

// === Sessions ===

export async function createSession(agentId: string): Promise<string | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('sessions')
    .insert({ agent_id: agentId })
    .select('id')
    .single();
  if (error) { console.error('createSession error:', error); return null; }
  return data.id;
}

export async function endSession(sessionId: string): Promise<void> {
  if (!isSupabaseEnabled()) return;
  await supabase!
    .from('sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', sessionId);
}

// === Messages ===

export async function saveMessage(
  sessionId: string, role: Message['role'], content: string
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  await supabase!.from('messages').insert({ session_id: sessionId, role, content });
}

export async function getMessagesBySession(sessionId: string): Promise<ChatMessage[]> {
  if (!isSupabaseEnabled()) return [];
  try {
    const { data, error } = await supabase!
      .from('messages')
      .select('id, role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error || !data) return [];

    return data.map(m => ({
      id: m.id,
      type: (m.role === 'thought' || m.role === 'action') ? 'agent' as const : m.role as ChatMessage['type'],
      content: m.content,
      timestamp: new Date(m.created_at).getTime(),
    }));
  } catch {
    return [];
  }
}

// === Findings ===

export async function createFinding(finding: Omit<Finding, 'id' | 'created_at'>): Promise<Finding | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('findings')
    .insert(finding)
    .select()
    .single();
  if (error) { console.error('createFinding error:', error); return null; }

  // Increment findings_count on session
  try {
    await supabase!.rpc('increment_findings_count', { sid: finding.session_id });
  } catch {
    // Best effort
  }

  return data;
}

export async function listFindings(
  agentId: string,
  filters: { type?: FindingType; severity?: Criticality; status?: FindingStatus },
  limit = 50, offset = 0
): Promise<{ findings: Finding[]; total: number }> {
  if (!isSupabaseEnabled()) return { findings: [], total: 0 };

  let query = supabase!.from('findings').select('*', { count: 'exact' }).eq('agent_id', agentId);

  if (filters.type) query = query.eq('type', filters.type);
  if (filters.severity) query = query.eq('severity', filters.severity);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { console.error('listFindings error:', error); return { findings: [], total: 0 }; }
  return { findings: data ?? [], total: count ?? 0 };
}

export async function updateFindingStatus(
  findingId: string, status: FindingStatus
): Promise<Finding | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('findings')
    .update({ status })
    .eq('id', findingId)
    .select()
    .single();
  if (error) { console.error('updateFindingStatus error:', error); return null; }
  return data;
}

// === Screenshot Upload ===

export async function uploadScreenshot(
  agentId: string, base64Data: string
): Promise<string | null> {
  if (!isSupabaseEnabled()) return null;
  const buffer = Buffer.from(base64Data, 'base64');
  const filename = `${agentId}/${Date.now()}.png`;

  const { error } = await supabase!.storage
    .from('screenshots')
    .upload(filename, buffer, { contentType: 'image/png' });
  if (error) { console.error('uploadScreenshot error:', error); return null; }

  const { data } = supabase!.storage.from('screenshots').getPublicUrl(filename);
  return data.publicUrl;
}

// === Memory Suggestions ===

export async function createSuggestion(
  agentId: string,
  type: Suggestion['type'],
  data: Suggestion['data'],
  sessionId: string | null
): Promise<Suggestion | null> {
  if (!isSupabaseEnabled()) return null;

  // --- Deduplication ---
  const name = 'name' in data ? (data as any).name : ('feature_name' in data ? (data as any).feature_name : null);

  if (name) {
    // Level 1: Check for existing pending/dismissed suggestions with same type
    const { data: existingSuggs } = await supabase!
      .from('memory_suggestions')
      .select('id, data, status')
      .eq('agent_id', agentId)
      .eq('type', type)
      .in('status', ['pending', 'dismissed']);

    if (existingSuggs) {
      if (type === 'behavior') {
        // For behaviors, check both feature_name AND behavior text (exact match)
        const bd = data as BehaviorSuggestionData;
        const isDupe = existingSuggs.some((s: any) =>
          s.data?.feature_name?.toLowerCase() === bd.feature_name.toLowerCase()
          && s.data?.behavior === bd.behavior
        );
        if (isDupe) {
          console.log(`[DEDUP] Skipping duplicate behavior suggestion: "${bd.behavior}" for feature "${bd.feature_name}"`);
          return null;
        }
      } else {
        // For features/flows, use fuzzy entity resolver
        const pendingNames: string[] = existingSuggs
          .filter((s: any) => s.data?.name)
          .map((s: any) => s.data.name as string);

        // Also include aliases stored in each suggestion's data
        const aliasNames: string[] = [];
        for (const s of existingSuggs) {
          const aliases = (s.data as any)?.aliases;
          if (Array.isArray(aliases)) {
            aliasNames.push(...aliases);
          }
        }

        const allPendingNames = [...pendingNames, ...aliasNames];
        const match = allPendingNames.length > 0 ? isDuplicate(name, allPendingNames) : null;

        if (match) {
          // Find the original suggestion that owns this name (not an alias match)
          const matchedSugg = existingSuggs.find((s: any) => s.data?.name === match.matchedName);

          if (matchedSugg && matchedSugg.status === 'pending') {
            // Add the new name as an alias on the existing pending suggestion
            const currentAliases: string[] = (matchedSugg.data as any)?.aliases ?? [];
            if (!currentAliases.includes(name)) {
              const updatedData = { ...(matchedSugg.data as any), aliases: [...currentAliases, name] };
              await supabase!
                .from('memory_suggestions')
                .update({ data: updatedData })
                .eq('id', matchedSugg.id);
              console.log(`[DEDUP] Added alias "${name}" to pending suggestion "${match.matchedName}" (method=${match.method}, similarity=${match.similarity.toFixed(2)})`);
            }
          } else {
            console.log(`[DEDUP] Skipping duplicate ${type} suggestion: "${name}" matches "${match.matchedName}" (method=${match.method}, similarity=${match.similarity.toFixed(2)})`);
          }
          return null;
        }
      }
    }

    // Level 2: Check for already-accepted entities
    if (type === 'feature') {
      const { data: acceptedFeatures } = await supabase!
        .from('memory_features')
        .select('name')
        .eq('agent_id', agentId);

      const acceptedNames: string[] = (acceptedFeatures ?? []).map((f: any) => f.name as string);

      // Also include aliases from pending/dismissed suggestions for broader coverage
      const aliasNames: string[] = [];
      if (existingSuggs) {
        for (const s of existingSuggs) {
          const aliases = (s.data as any)?.aliases;
          if (Array.isArray(aliases)) {
            aliasNames.push(...aliases);
          }
        }
      }

      const allKnownNames = [...acceptedNames, ...aliasNames];
      const match = allKnownNames.length > 0 ? isDuplicate(name, allKnownNames) : null;
      if (match) {
        console.log(`[DEDUP] Skipping feature suggestion: "${name}" matches accepted feature "${match.matchedName}" (method=${match.method}, similarity=${match.similarity.toFixed(2)})`);
        return null;
      }
    }

    if (type === 'flow') {
      // Check if a flow with this name already exists under the parent feature
      const fd = data as FlowSuggestionData;
      const feature = await findFeatureByName(agentId, fd.feature_name);
      if (feature) {
        const { data: existingFlows } = await supabase!
          .from('memory_flows')
          .select('name')
          .eq('feature_id', feature.id);

        const flowNames: string[] = (existingFlows ?? []).map((f: any) => f.name as string);
        const match = flowNames.length > 0 ? isDuplicate(fd.name, flowNames) : null;
        if (match) {
          console.log(`[DEDUP] Skipping flow suggestion: "${fd.name}" matches accepted flow "${match.matchedName}" under feature "${fd.feature_name}" (method=${match.method}, similarity=${match.similarity.toFixed(2)})`);
          return null;
        }
      }
    }

    if (type === 'behavior') {
      const bd = data as BehaviorSuggestionData;
      const feature = await findFeatureByName(agentId, bd.feature_name);
      if (feature && feature.expected_behaviors?.includes(bd.behavior)) {
        console.log(`[DEDUP] Skipping behavior suggestion: identical behavior already accepted for feature "${bd.feature_name}"`);
        return null; // Identical behavior already accepted
      }
    }
  }

  // --- Insert ---
  const { data: inserted, error } = await supabase!
    .from('memory_suggestions')
    .insert({
      agent_id: agentId,
      type,
      data,
      source_session: sessionId,
    })
    .select()
    .single();

  if (error) { console.error('createSuggestion error:', error); return null; }
  return inserted;
}

export async function listPendingSuggestions(agentId: string): Promise<Suggestion[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('memory_suggestions')
    .select('*')
    .eq('agent_id', agentId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) { console.error('listPendingSuggestions error:', error); return []; }
  return data ?? [];
}

export async function getPendingSuggestionCount(agentId: string): Promise<number> {
  if (!isSupabaseEnabled()) return 0;
  const { count, error } = await supabase!
    .from('memory_suggestions')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'pending');
  if (error) { console.error('getPendingSuggestionCount error:', error); return 0; }
  return count ?? 0;
}

export async function acceptSuggestion(suggestionId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;

  const { data: suggestion, error: fetchError } = await supabase!
    .from('memory_suggestions')
    .select('*')
    .eq('id', suggestionId)
    .single();

  if (fetchError || !suggestion) return false;

  const { type, data: suggData, agent_id: agentId } = suggestion;

  // Process by type
  if (type === 'feature') {
    const fd = suggData as FeatureSuggestionData;
    const created = await createFeature(agentId, fd.name, fd.description, fd.criticality, fd.expected_behaviors);

    // Link feature to nav node if discovery URL is known
    if (created && fd.discovered_at_url) {
      try {
        const urlPattern = normalizeUrl(fd.discovered_at_url);
        const { data: node } = await supabase!
          .from('nav_nodes')
          .select('id')
          .eq('agent_id', agentId)
          .eq('url_pattern', urlPattern)
          .maybeSingle();

        if (node) {
          await supabase!
            .from('nav_node_features')
            .upsert(
              { nav_node_id: node.id, feature_id: created.id },
              { onConflict: 'nav_node_id,feature_id', ignoreDuplicates: true }
            );
        } else {
          console.warn(`[DB] No nav_node found for URL pattern "${urlPattern}" — skipping feature link`);
        }
      } catch (err) {
        console.warn('[DB] Failed to link feature to nav node:', err);
      }
    }
  } else if (type === 'flow') {
    const fd = suggData as FlowSuggestionData;
    let feature = await findFeatureByName(agentId, fd.feature_name);
    if (!feature) {
      feature = await createFeature(agentId, fd.feature_name, null, fd.criticality, []);
    }
    if (feature) {
      await createFlow(feature.id, agentId, fd.name, fd.steps, fd.checkpoints, fd.criticality);

      // Link feature to nav node if discovery URL is known
      if (fd.discovered_at_url) {
        try {
          const urlPattern = normalizeUrl(fd.discovered_at_url);
          const { data: node } = await supabase!
            .from('nav_nodes')
            .select('id')
            .eq('agent_id', agentId)
            .eq('url_pattern', urlPattern)
            .maybeSingle();

          if (node) {
            await supabase!
              .from('nav_node_features')
              .upsert(
                { nav_node_id: node.id, feature_id: feature.id },
                { onConflict: 'nav_node_id,feature_id', ignoreDuplicates: true }
              );
          }
        } catch (err) {
          console.warn('[DB] Failed to link flow feature to nav node:', err);
        }
      }
    }
  } else if (type === 'behavior') {
    const fd = suggData as BehaviorSuggestionData;
    let feature = await findFeatureByName(agentId, fd.feature_name);
    if (!feature) {
      feature = await createFeature(agentId, fd.feature_name, null, 'medium', []);
    }
    if (feature) {
      await supabase!.rpc('append_expected_behavior', {
        feature_uuid: feature.id,
        new_behavior: fd.behavior,
      });
    }
  }

  // Mark as accepted
  const { error } = await supabase!
    .from('memory_suggestions')
    .update({ status: 'accepted', resolved_at: new Date().toISOString() })
    .eq('id', suggestionId);

  return !error;
}

export async function dismissSuggestion(suggestionId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!
    .from('memory_suggestions')
    .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
    .eq('id', suggestionId);
  return !error;
}

export async function updateSuggestionData(
  suggestionId: string,
  data: Suggestion['data']
): Promise<Suggestion | null> {
  if (!isSupabaseEnabled()) return null;
  const { data: updated, error } = await supabase!
    .from('memory_suggestions')
    .update({ data })
    .eq('id', suggestionId)
    .select()
    .single();
  if (error) { console.error('updateSuggestionData error:', error); return null; }
  return updated;
}

export async function bulkAcceptSuggestions(agentId: string): Promise<number> {
  if (!isSupabaseEnabled()) return 0;
  const pending = await listPendingSuggestions(agentId);
  if (pending.length === 0) return 0;

  // Process in order: features first, then flows, then behaviors
  const features = pending.filter(s => s.type === 'feature');
  const flows = pending.filter(s => s.type === 'flow');
  const behaviors = pending.filter(s => s.type === 'behavior');

  let accepted = 0;
  for (const s of [...features, ...flows, ...behaviors]) {
    const ok = await acceptSuggestion(s.id);
    if (ok) accepted++;
  }
  return accepted;
}

export async function bulkDismissSuggestions(agentId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!
    .from('memory_suggestions')
    .update({ status: 'dismissed', resolved_at: new Date().toISOString() })
    .eq('agent_id', agentId)
    .eq('status', 'pending');
  return !error;
}

// === Eval Cases ===

export async function createEvalCase(evalCase: Omit<EvalCase, 'id' | 'created_at' | 'updated_at'>): Promise<EvalCase | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_cases')
    .insert(evalCase)
    .select()
    .single();
  if (error) { console.error('createEvalCase error:', error); return null; }
  return data;
}

export async function listEvalCases(
  agentId: string,
  filters?: { status?: EvalCase['status']; tags?: string[] }
): Promise<EvalCase[]> {
  if (!isSupabaseEnabled()) return [];
  let query = supabase!
    .from('eval_cases')
    .select('*')
    .eq('agent_id', agentId);

  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.tags && filters.tags.length > 0) query = query.overlaps('tags', filters.tags);

  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) { console.error('listEvalCases error:', error); return []; }
  return data ?? [];
}

export async function getEvalCase(caseId: string): Promise<EvalCase | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_cases')
    .select('*')
    .eq('id', caseId)
    .single();
  if (error) return null;
  return data;
}

export async function updateEvalCase(
  caseId: string,
  updates: Partial<Pick<EvalCase, 'name' | 'task_prompt' | 'checks' | 'llm_judge_criteria' | 'tags' | 'status'>>
): Promise<EvalCase | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_cases')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', caseId)
    .select()
    .single();
  if (error) { console.error('updateEvalCase error:', error); return null; }
  return data;
}

export async function deleteEvalCase(caseId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!.from('eval_cases').delete().eq('id', caseId);
  return !error;
}

// === Eval Runs ===

export async function createEvalRun(agentId: string, trigger: EvalRunTrigger): Promise<EvalRun | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_runs')
    .insert({ agent_id: agentId, trigger, status: 'running' as EvalRunStatus })
    .select()
    .single();
  if (error) { console.error('createEvalRun error:', error); return null; }
  return data;
}

export async function getEvalRun(runId: string): Promise<EvalRun | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_runs')
    .select('*')
    .eq('id', runId)
    .single();
  if (error) return null;
  return data;
}

export async function listEvalRuns(agentId: string, limit = 20): Promise<EvalRun[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('eval_runs')
    .select('*')
    .eq('agent_id', agentId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('listEvalRuns error:', error); return []; }
  return data ?? [];
}

export async function updateEvalRun(
  runId: string,
  updates: Partial<Pick<EvalRun, 'status' | 'summary' | 'completed_at'>>
): Promise<EvalRun | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_runs')
    .update(updates)
    .eq('id', runId)
    .select()
    .single();
  if (error) { console.error('updateEvalRun error:', error); return null; }
  return data;
}

export async function getEvalRunStatus(runId: string): Promise<EvalRunStatus | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_runs')
    .select('status')
    .eq('id', runId)
    .single();
  if (error) return null;
  return data?.status ?? null;
}

// === Eval Results ===

export async function createEvalResult(result: Omit<EvalResult, 'id'>): Promise<EvalResult | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('eval_results')
    .insert(result)
    .select()
    .single();
  if (error) { console.error('createEvalResult error:', error); return null; }
  return data;
}

export async function listEvalResults(runId: string): Promise<EvalResult[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('eval_results')
    .select('*')
    .eq('run_id', runId)
    .order('case_id', { ascending: true });
  if (error) { console.error('listEvalResults error:', error); return []; }
  return data ?? [];
}

// === Agent Eval Schedule ===

export async function updateAgentEvalSchedule(agentId: string, cronSchedule: string | null): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!
    .from('agents')
    .update({ eval_cron_schedule: cronSchedule, updated_at: new Date().toISOString() })
    .eq('id', agentId);
  if (error) { console.error('updateAgentEvalSchedule error:', error); return false; }
  return true;
}

export async function getAgentsWithEvalSchedule(): Promise<Agent[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('agents')
    .select('*')
    .not('eval_cron_schedule', 'is', null);
  if (error) { console.error('getAgentsWithEvalSchedule error:', error); return []; }
  return data ?? [];
}

// === Tasks ===

export async function createTask(sessionId: string, agentId: string, prompt: string): Promise<string> {
  const { data, error } = await supabase!
    .from('tasks')
    .insert({ session_id: sessionId, agent_id: agentId, prompt, status: 'running', started_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function updateTask(taskId: string, updates: { status?: string; success?: boolean; error_message?: string; completed_at?: string }): Promise<void> {
  const { error } = await supabase!.from('tasks').update(updates).eq('id', taskId);
  if (error) throw error;
}

export async function getTasksBySession(sessionId: string): Promise<Task[]> {
  const { data, error } = await supabase!
    .from('tasks')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createExecutionStep(taskId: string, stepOrder: number, stepType: StepType, fields: { content?: string; target?: string; screenshot_url?: string; duration_ms?: number }): Promise<string> {
  const { data, error } = await supabase!
    .from('execution_steps')
    .insert({ task_id: taskId, step_order: stepOrder, step_type: stepType, ...fields })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

export async function getStepsByTask(taskId: string): Promise<ExecutionStep[]> {
  const { data, error } = await supabase!
    .from('execution_steps')
    .select('*')
    .eq('task_id', taskId)
    .order('step_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// --- Learning System: Task Feedback ---

export async function createTaskFeedback(feedback: {
  agent_id: string;
  task_id: string;
  session_id: string | null;
  rating: FeedbackRating;
  correction: string | null;
}): Promise<TaskFeedback | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('task_feedback')
    .insert(feedback)
    .select()
    .single();
  if (error) { console.error('createTaskFeedback error:', error); return null; }
  return data;
}

export async function getTaskFeedbackByTask(taskId: string): Promise<TaskFeedback | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('task_feedback')
    .select('*')
    .eq('task_id', taskId)
    .single();
  if (error) return null;
  return data;
}

export async function listTaskFeedback(
  agentId: string,
  filters?: { rating?: FeedbackRating; limit?: number }
): Promise<TaskFeedback[]> {
  if (!isSupabaseEnabled()) return [];
  let query = supabase!
    .from('task_feedback')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false });
  if (filters?.rating) query = query.eq('rating', filters.rating);
  if (filters?.limit) query = query.limit(filters.limit);
  const { data, error } = await query;
  if (error) { console.error('listTaskFeedback error:', error); return []; }
  return data ?? [];
}

// --- Learning System: Learning Pool ---

export async function addToLearningPool(entry: {
  task_id: string;
  agent_id: string;
  feedback: FeedbackRating;
  task_prompt: string;
  task_prompt_embedding: number[] | null;
  task_summary: string | null;
  task_summary_embedding: number[] | null;
  steps: any[];
  step_count: number;
  duration_ms: number | null;
  cluster_id?: string | null;
}): Promise<LearningPoolEntry | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('learning_pool')
    .insert(entry)
    .select()
    .single();
  if (error) { console.error('addToLearningPool error:', error); return null; }
  return data;
}

export async function listLearningPoolByCluster(
  clusterId: string,
  feedbackFilter?: FeedbackRating
): Promise<LearningPoolEntry[]> {
  if (!isSupabaseEnabled()) return [];
  let query = supabase!
    .from('learning_pool')
    .select('*')
    .eq('cluster_id', clusterId)
    .order('created_at', { ascending: true });
  if (feedbackFilter) query = query.eq('feedback', feedbackFilter);
  const { data, error } = await query;
  if (error) { console.error('listLearningPoolByCluster error:', error); return []; }
  return data ?? [];
}

export async function updateLearningPoolCluster(
  entryId: string,
  clusterId: string
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const { error } = await supabase!
    .from('learning_pool')
    .update({ cluster_id: clusterId })
    .eq('id', entryId);
  if (error) console.error('updateLearningPoolCluster error:', error);
}

export async function getTaskClusterByTask(taskId: string): Promise<TaskCluster | null> {
  if (!isSupabaseEnabled()) return null;

  // Step 1: Find the learning pool entry for this task
  const { data: poolEntry, error: poolError } = await supabase!
    .from('learning_pool')
    .select('cluster_id')
    .eq('task_id', taskId)
    .single();

  if (poolError || !poolEntry?.cluster_id) return null;

  // Step 2: Fetch the cluster
  return getTaskCluster(poolEntry.cluster_id);
}

export async function getLearningPoolStats(agentId: string): Promise<{
  total: number;
  positive: number;
  negative: number;
  clustered: number;
}> {
  if (!isSupabaseEnabled()) return { total: 0, positive: 0, negative: 0, clustered: 0 };
  const { data, error } = await supabase!
    .from('learning_pool')
    .select('feedback, cluster_id')
    .eq('agent_id', agentId);
  if (error || !data) return { total: 0, positive: 0, negative: 0, clustered: 0 };
  return {
    total: data.length,
    positive: data.filter(d => d.feedback === 'positive').length,
    negative: data.filter(d => d.feedback === 'negative').length,
    clustered: data.filter(d => d.cluster_id !== null).length,
  };
}

// --- Learning System: Task Clusters ---

export async function createTaskCluster(cluster: {
  agent_id: string;
  centroid_embedding: number[];
  task_summary: string;
  run_count?: number;
  app_fingerprint?: string | null;
}): Promise<TaskCluster | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('task_clusters')
    .insert({ ...cluster, run_count: cluster.run_count ?? 1 })
    .select()
    .single();
  if (error) { console.error('createTaskCluster error:', error); return null; }
  return data;
}

export async function getTaskCluster(clusterId: string): Promise<TaskCluster | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('task_clusters')
    .select('*')
    .eq('id', clusterId)
    .single();
  if (error) return null;
  return data;
}

export async function listTaskClusters(agentId: string): Promise<TaskCluster[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('task_clusters')
    .select('*')
    .eq('agent_id', agentId)
    .order('run_count', { ascending: false });
  if (error) { console.error('listTaskClusters error:', error); return []; }
  return data ?? [];
}

export async function updateTaskCluster(
  clusterId: string,
  updates: Partial<Pick<TaskCluster, 'centroid_embedding' | 'run_count' | 'task_summary'>>
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const { error } = await supabase!
    .from('task_clusters')
    .update(updates)
    .eq('id', clusterId);
  if (error) console.error('updateTaskCluster error:', error);
}

export async function incrementClusterRunCount(clusterId: string): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const cluster = await getTaskCluster(clusterId);
  if (cluster) {
    await updateTaskCluster(clusterId, { run_count: cluster.run_count + 1 });
  }
}

// --- Learning System: Extended Pattern Functions ---

export async function createTaskPattern(pattern: {
  agent_id: string;
  trigger: any;
  steps: any[];
  cluster_id: string;
  embedding: number[] | null;
  avg_steps: number;
  avg_duration_ms: number;
  success_rate: number;
  variance: number;
  score: number;
  app_fingerprint?: string | null;
}): Promise<LearnedPattern | null> {
  if (!isSupabaseEnabled()) return null;
  const { data, error } = await supabase!
    .from('learned_patterns')
    .insert({
      ...pattern,
      pattern_type: 'task',
      pattern_state: 'candidate',
      scope: 'agent',
      consecutive_failures: 0,
      use_count: 0,
    })
    .select()
    .single();
  if (error) { console.error('createTaskPattern error:', error); return null; }
  return data;
}

export async function listActivePatterns(
  agentId: string,
  patternType?: 'login' | 'navigation' | 'task'
): Promise<LearnedPattern[]> {
  if (!isSupabaseEnabled()) return [];
  let query = supabase!
    .from('learned_patterns')
    .select('*')
    .eq('agent_id', agentId)
    .in('pattern_state', ['active', 'dominant']);
  if (patternType) query = query.eq('pattern_type', patternType);
  const { data, error } = await query;
  if (error) { console.error('listActivePatterns error:', error); return []; }
  return data ?? [];
}

export async function updatePatternState(
  patternId: string,
  state: PatternState,
  updates?: Partial<Pick<LearnedPattern, 'success_rate' | 'score' | 'consecutive_failures' | 'last_verified_success' | 'use_count' | 'last_used_at'>>
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const { error } = await supabase!
    .from('learned_patterns')
    .update({ pattern_state: state, ...updates, updated_at: new Date().toISOString() })
    .eq('id', patternId);
  if (error) console.error('updatePatternState error:', error);
}

export async function listPatternsByCluster(clusterId: string): Promise<LearnedPattern[]> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('learned_patterns')
    .select('*')
    .eq('cluster_id', clusterId)
    .not('pattern_state', 'eq', 'archived');
  if (error) { console.error('listPatternsByCluster error:', error); return []; }
  return data ?? [];
}

export async function deletePattern(patternId: string): Promise<boolean> {
  if (!isSupabaseEnabled()) return false;
  const { error } = await supabase!
    .from('learned_patterns')
    .delete()
    .eq('id', patternId);
  if (error) { console.error('deletePattern error:', error); return false; }
  return true;
}

export async function getPatternStats(agentId: string): Promise<{
  total: number;
  candidate: number;
  active: number;
  dominant: number;
  stale: number;
}> {
  if (!isSupabaseEnabled()) return { total: 0, candidate: 0, active: 0, dominant: 0, stale: 0 };
  const { data, error } = await supabase!
    .from('learned_patterns')
    .select('pattern_state')
    .eq('agent_id', agentId)
    .eq('pattern_type', 'task')
    .not('pattern_state', 'eq', 'archived');
  if (error || !data) return { total: 0, candidate: 0, active: 0, dominant: 0, stale: 0 };
  return {
    total: data.length,
    candidate: data.filter(d => d.pattern_state === 'candidate').length,
    active: data.filter(d => d.pattern_state === 'active').length,
    dominant: data.filter(d => d.pattern_state === 'dominant').length,
    stale: data.filter(d => d.pattern_state === 'stale').length,
  };
}

export async function listExecutionSteps(taskId: string): Promise<Array<{
  id: string; task_id: string; step_order: number; step_type: string;
  content: string; target: string | null; screenshot_url: string | null;
  duration_ms: number | null; created_at: string;
}>> {
  if (!isSupabaseEnabled()) return [];
  const { data, error } = await supabase!
    .from('execution_steps')
    .select('*')
    .eq('task_id', taskId)
    .order('step_order', { ascending: true });
  if (error) { console.error('listExecutionSteps error:', error); return []; }
  return data ?? [];
}
