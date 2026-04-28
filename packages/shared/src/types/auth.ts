// Phase 3 — wire types for auth.
export type Role = 'admin' | 'user' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  monthly_spend_cap_usd: number | null;
  can_override_model: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: AuthUser;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
}
