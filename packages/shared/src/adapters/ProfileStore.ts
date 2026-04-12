// ─── Profile Types ───────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  preferredName?: string;

  /** Key-value preferences extracted from conversation */
  preferences: Record<string, any>;

  /** Structured life context */
  context: {
    role?: string;        // "Software engineer at Acme"
    location?: string;    // "Bangalore, India"
    timezone?: string;    // "Asia/Kolkata"
    workHours?: string;   // "10am-7pm"
    interests?: string[];
    goals?: string[];
    [key: string]: any;
  };

  /** Last time the profile was updated */
  updatedAt: string;

  /** Number of conversations that contributed to this profile */
  version: number;
}

// ─── Core Adapter Interface ─────────────────────────────────────────────────

/**
 * Manages the structured user profile — who the user is,
 * what they prefer, and what JARVIS has learned about them.
 *
 * Every conversation can contribute profile updates.
 * The profile is versioned so we can track how understanding evolves.
 */
export interface ProfileStore {
  getProfile(id: string): Promise<UserProfile | null>;
  updateProfile(id: string, updates: Partial<UserProfile>): Promise<UserProfile>;
  getProfileHistory(id: string, limit?: number): Promise<UserProfile[]>;
  initProfile(id: string, name: string): Promise<UserProfile>;
}
