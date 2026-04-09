export type Tier = "gold" | "silver" | "copper";
export type AccountKind = "client" | "developer";

export type TicketKind =
  | "client_job"
  | "client_support"
  | "dev_profile"
  | "dev_application"
  | "safety";

export type TicketCounters = Record<TicketKind, number>;

export type ProfileStatus = "pending" | "approved" | "rejected";
export type JobStatus = "draft" | "published" | "paused" | "in_progress" | "closed";
export type ApplicationStatus =
  | "submitted"
  | "connected"
  | "shortlisted"
  | "rejected"
  | "hired"
  | "completed"
  | "stopped"
  | "closed"
  | "approved"
  | "withdrawn";
export type ApplicationOrigin = "developer_apply" | "client_invite";

export interface ProfileRecord {
  id: string;
  userId: string;
  headline: string;
  bio: string;
  previousProjects: string;
  skills: string[];
  portfolioLinks: string[];
  resumeFileName?: string;
  resumeFileUrl?: string;
  resumeUploadedAt?: string;
  availability: string;
  trustScore: number;
  moderatorStars: number;
  completedContracts: number;
  stoppedContracts: number;
  disputeCount: number;
  feedbackCount: number;
  feedbackAverage: number;
  status: ProfileStatus;
  approvedTier?: Tier;
  visibilityTiers: Tier[];
  networkRegisteredAt: string;
  privateChannelId?: string;
  publishedPostIds: Partial<Record<Tier, string>>;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  clientId: string;
  marketTier: Tier;
  title: string;
  summary: string;
  skills: string[];
  budget: string;
  timeline: string;
  visibilityTiers: Tier[];
  status: JobStatus;
  privateChannelId: string;
  privateMessageId?: string;
  privateControlsMessageId?: string;
  publishedPostIds: Partial<Record<Tier, string>>;
  applicationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationRecord {
  id: string;
  jobId: string;
  devUserId: string;
  origin: ApplicationOrigin;
  pitch: string;
  matchingSkills: string[];
  rate: string;
  availability: string;
  status: ApplicationStatus;
  reviewMessageId?: string;
  privateChannelId?: string;
  privateMessageId?: string;
  feedbackId?: string;
  score?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackRecord {
  id: string;
  jobId: string;
  applicationId: string;
  clientUserId: string;
  devUserId: string;
  jobTitle: string;
  outcome: "completed" | "stopped";
  score: number;
  message: string;
  createdAt: string;
}

export interface AccessRecord {
  userId: string;
  kinds: AccountKind[];
  tier: Tier;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
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
  feedbacks: FeedbackRecord[];
  access: AccessRecord[];
  tickets: TicketRecord[];
  counters: {
    profile: number;
    job: number;
    application: number;
    feedback: number;
    ticket: number;
    deal: number;
    ticketByKind: TicketCounters;
  };
}
