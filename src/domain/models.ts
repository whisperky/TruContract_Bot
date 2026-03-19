export type Tier = "gold" | "silver" | "copper";

export type TicketKind =
  | "client_job"
  | "client_support"
  | "dev_profile"
  | "dev_application"
  | "safety";

export type ProfileStatus = "pending" | "approved" | "rejected";
export type JobStatus = "draft" | "published" | "paused" | "closed";
export type ApplicationStatus =
  | "submitted"
  | "shortlisted"
  | "rejected"
  | "approved"
  | "withdrawn";

export interface ProfileRecord {
  id: string;
  userId: string;
  headline: string;
  bio: string;
  skills: string[];
  portfolioLinks: string[];
  availability: string;
  trustScore: number;
  moderatorStars: number;
  status: ProfileStatus;
  approvedTier?: Tier;
  privateChannelId?: string;
  publishedPostIds: Partial<Record<Tier, string>>;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  clientId: string;
  title: string;
  summary: string;
  skills: string[];
  budget: string;
  timeline: string;
  visibilityTiers: Tier[];
  status: JobStatus;
  privateChannelId: string;
  publishedPostIds: Partial<Record<Tier, string>>;
  applicationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationRecord {
  id: string;
  jobId: string;
  devUserId: string;
  pitch: string;
  matchingSkills: string[];
  rate: string;
  availability: string;
  status: ApplicationStatus;
  privateChannelId?: string;
  score?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TicketRecord {
  id: string;
  kind: TicketKind;
  ownerId: string;
  channelId: string;
  relatedJobId?: string;
  relatedApplicationId?: string;
  createdAt: string;
  closedAt?: string;
}

export interface StoreSchema {
  profiles: ProfileRecord[];
  jobs: JobRecord[];
  applications: ApplicationRecord[];
  tickets: TicketRecord[];
  counters: {
    profile: number;
    job: number;
    application: number;
    ticket: number;
    deal: number;
  };
}
