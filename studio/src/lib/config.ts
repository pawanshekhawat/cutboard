const rawApiBase = (import.meta.env.VITE_CUTBOARD_API_BASE as string | undefined)?.trim();
const rawProjectPath = (import.meta.env.VITE_CUTBOARD_PROJECT_PATH as string | undefined)?.trim();

export const API_BASE = (rawApiBase && rawApiBase.length > 0 ? rawApiBase : 'http://localhost:3001').replace(/\/+$/, '');
export const PROJECT_PATH = rawProjectPath && rawProjectPath.length > 0 ? rawProjectPath : undefined;

export function buildApiUrl(path: string): string {
  const normalizedPath = `/${path.replace(/^\/+/, '')}`;
  return `${API_BASE}${normalizedPath}`;
}

export function withProjectPath(params?: Record<string, unknown>): Record<string, unknown> {
  if (!PROJECT_PATH) return params ?? {};
  return { ...(params ?? {}), path: PROJECT_PATH };
}
