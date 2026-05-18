const RAW = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
export const API_BASE = RAW;

export function apiUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error('apiUrl: path must start with /');
  return `${API_BASE}${path}`;
}
