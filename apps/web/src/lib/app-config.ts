// TP-0 — app-level config read once at boot (authed). Drives which modules
// the shell renders. Cached aggressively; flipping the admin toggle takes
// effect on the next full load / query invalidation.
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface AppConfig {
  planning_enabled: boolean;
}

const DEFAULT_CONFIG: AppConfig = { planning_enabled: false };

export function useAppConfig(): AppConfig {
  const { data } = useQuery<AppConfig>({
    queryKey: ['config'],
    queryFn: () => api('/api/config'),
    staleTime: 5 * 60 * 1000,
  });
  return data ?? DEFAULT_CONFIG;
}
