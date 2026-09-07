import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export let supabase: SupabaseClient | null = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.warn('Supabase credentials not configured. Database persistence disabled.');
}

export function isSupabaseEnabled(): boolean {
  return supabase !== null;
}

// --- Authentication ---

export interface AuthenticatedUser {
  id: string;
  email: string;
  githubUsername: string;
}

const ALLOWED_GITHUB_USERS = (process.env.ALLOWED_GITHUB_USERS || '')
  .split(',')
  .map(u => u.trim().toLowerCase())
  .filter(Boolean);

export async function verifyToken(token: string): Promise<AuthenticatedUser> {
  if (!supabase) throw new Error('Supabase not configured');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error('Invalid or expired token');

  const githubUsername = (data.user.user_metadata?.user_name as string) || '';

  if (ALLOWED_GITHUB_USERS.length > 0 && !ALLOWED_GITHUB_USERS.includes(githubUsername.toLowerCase())) {
    throw new Error('User not in allowlist');
  }

  return { id: data.user.id, email: data.user.email ?? '', githubUsername };
}
