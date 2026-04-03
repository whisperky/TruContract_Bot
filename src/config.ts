import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  STAFF_ROLE_IDS: z.string().min(1),
  CLIENT_GOLD_DESK_CHANNEL_ID: z.string().min(1),
  CLIENT_SILVER_DESK_CHANNEL_ID: z.string().min(1),
  CLIENT_COPPER_DESK_CHANNEL_ID: z.string().min(1),
  DEV_GOLD_DESK_CHANNEL_ID: z.string().min(1),
  DEV_SILVER_DESK_CHANNEL_ID: z.string().min(1),
  DEV_COPPER_DESK_CHANNEL_ID: z.string().min(1),
  SAFETY_DESK_CHANNEL_ID: z.string().min(1),
  CLIENT_PRIVATE_CATEGORY_ID: z.string().min(1),
  DEV_PRIVATE_CATEGORY_ID: z.string().min(1),
  CASE_PRIVATE_CATEGORY_ID: z.string().min(1),
  GOLD_OPPORTUNITIES_FORUM_ID: z.string().min(1),
  SILVER_OPPORTUNITIES_FORUM_ID: z.string().min(1),
  COPPER_OPPORTUNITIES_FORUM_ID: z.string().min(1),
  GOLD_TALENT_FORUM_ID: z.string().min(1),
  SILVER_TALENT_FORUM_ID: z.string().min(1),
  COPPER_TALENT_FORUM_ID: z.string().min(1),
  NETWORK_GOLD_ROLE_ID: z.string().min(1),
  NETWORK_SILVER_ROLE_ID: z.string().min(1),
  NETWORK_COPPER_ROLE_ID: z.string().min(1),
  CLIENT_GOLD_ROLE_ID: z.string().min(1).optional(),
  CLIENT_SILVER_ROLE_ID: z.string().min(1).optional(),
  CLIENT_COPPER_ROLE_ID: z.string().min(1).optional(),
  DEV_GOLD_ROLE_ID: z.string().min(1).optional(),
  DEV_SILVER_ROLE_ID: z.string().min(1).optional(),
  DEV_COPPER_ROLE_ID: z.string().min(1).optional(),
  STORE_FILE: z.string().default("./data/store.json")
});

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const raw = envSchema.parse(process.env);

export const config = {
  token: raw.DISCORD_TOKEN,
  clientId: raw.DISCORD_CLIENT_ID,
  guildId: raw.DISCORD_GUILD_ID,
  staffRoleIds: parseCsv(raw.STAFF_ROLE_IDS),
  channelIds: {
    clientDesk: {
      gold: raw.CLIENT_GOLD_DESK_CHANNEL_ID,
      silver: raw.CLIENT_SILVER_DESK_CHANNEL_ID,
      copper: raw.CLIENT_COPPER_DESK_CHANNEL_ID
    },
    devDesk: {
      gold: raw.DEV_GOLD_DESK_CHANNEL_ID,
      silver: raw.DEV_SILVER_DESK_CHANNEL_ID,
      copper: raw.DEV_COPPER_DESK_CHANNEL_ID
    },
    safetyDesk: raw.SAFETY_DESK_CHANNEL_ID
  },
  categoryIds: {
    clientPrivate: raw.CLIENT_PRIVATE_CATEGORY_ID,
    devPrivate: raw.DEV_PRIVATE_CATEGORY_ID,
    casePrivate: raw.CASE_PRIVATE_CATEGORY_ID
  },
  forums: {
    opportunities: {
      gold: raw.GOLD_OPPORTUNITIES_FORUM_ID,
      silver: raw.SILVER_OPPORTUNITIES_FORUM_ID,
      copper: raw.COPPER_OPPORTUNITIES_FORUM_ID
    },
    talent: {
      gold: raw.GOLD_TALENT_FORUM_ID,
      silver: raw.SILVER_TALENT_FORUM_ID,
      copper: raw.COPPER_TALENT_FORUM_ID
    }
  },
  roleIds: {
    network: {
      gold: raw.NETWORK_GOLD_ROLE_ID,
      silver: raw.NETWORK_SILVER_ROLE_ID,
      copper: raw.NETWORK_COPPER_ROLE_ID
    },
    legacy: {
      client: {
        gold: raw.CLIENT_GOLD_ROLE_ID,
        silver: raw.CLIENT_SILVER_ROLE_ID,
        copper: raw.CLIENT_COPPER_ROLE_ID
      },
      dev: {
        gold: raw.DEV_GOLD_ROLE_ID,
        silver: raw.DEV_SILVER_ROLE_ID,
        copper: raw.DEV_COPPER_ROLE_ID
      }
    }
  },
  storeFile: raw.STORE_FILE
};

export type AppConfig = typeof config;
