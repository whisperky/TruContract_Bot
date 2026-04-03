import type { GuildMember } from "discord.js";

import type { AppConfig } from "../config.js";
import type { AccessRecord, AccountKind, Tier } from "../domain/models.js";
import { JsonStore } from "../storage/JsonStore.js";
import { nowIso } from "../utils/id.js";
import { canAccessMarket, getAccessibleMarketTiers } from "../utils/tier.js";

const ACCESS_KINDS: AccountKind[] = ["client", "developer"];

export class AccessService {
  constructor(
    private readonly store: JsonStore,
    private readonly appConfig: AppConfig
  ) {}

  async getAccess(userId: string): Promise<AccessRecord | null> {
    const snapshot = await this.store.get();
    return snapshot.access.find((record) => record.userId === userId) ?? null;
  }

  async hasKind(userId: string, kind: AccountKind): Promise<boolean> {
    const access = await this.getAccess(userId);
    return access?.kinds.includes(kind) ?? false;
  }

  async getTierForKind(userId: string, kind: AccountKind): Promise<Tier | null> {
    const access = await this.getAccess(userId);
    if (!access || !access.kinds.includes(kind)) {
      return null;
    }

    return access.tier;
  }

  async getAllowedClientPublishTiers(userId: string): Promise<Tier[]> {
    return this.getAccessibleMarketTiersForKind(userId, "client");
  }

  async getAccessibleMarketTiersForKind(userId: string, kind: AccountKind): Promise<Tier[]> {
    const tier = await this.getTierForKind(userId, kind);
    if (!tier) {
      return [];
    }

    return getAccessibleMarketTiers(tier);
  }

  async canAccessMarket(userId: string, kind: AccountKind, marketTier: Tier): Promise<boolean> {
    const tier = await this.getTierForKind(userId, kind);
    if (!tier) {
      return false;
    }

    return canAccessMarket(tier, marketTier);
  }

  async setAccess(
    member: GuildMember,
    payload: {
      kinds: AccountKind[];
      tier?: Tier;
      updatedBy: string;
    }
  ): Promise<AccessRecord | null> {
    const kinds = [...new Set(payload.kinds.filter((kind): kind is AccountKind => ACCESS_KINDS.includes(kind)))];
    const now = nowIso();

    const record = await this.store.mutate((draft) => {
      const existingIndex = draft.access.findIndex((item) => item.userId === member.id);

      if (kinds.length === 0) {
        if (existingIndex !== -1) {
          draft.access.splice(existingIndex, 1);
        }
        return null;
      }

      if (!payload.tier) {
        throw new Error("A network tier is required when granting access.");
      }

      if (existingIndex !== -1) {
        const existing = draft.access[existingIndex];
        if (!existing) {
          throw new Error(`Access record for ${member.id} could not be loaded.`);
        }
        existing.kinds = kinds;
        existing.tier = payload.tier;
        existing.updatedAt = now;
        existing.updatedBy = payload.updatedBy;
        return structuredClone(existing);
      }

      const created: AccessRecord = {
        userId: member.id,
        kinds,
        tier: payload.tier,
        createdAt: now,
        updatedAt: now,
        updatedBy: payload.updatedBy
      };
      draft.access.push(created);
      return structuredClone(created);
    });

    await this.syncNeutralTierRoles(member, record?.tier ?? null);
    return record;
  }

  async ensureKindsAndTier(
    member: GuildMember,
    payload: {
      requiredKinds: AccountKind[];
      tier: Tier;
      updatedBy: string;
    }
  ): Promise<AccessRecord> {
    const existing = await this.getAccess(member.id);
    const kinds = existing
      ? [...new Set([...existing.kinds, ...payload.requiredKinds])]
      : [...new Set(payload.requiredKinds)];
    const record = await this.setAccess(member, {
      kinds,
      tier: payload.tier,
      updatedBy: payload.updatedBy
    });

    if (!record) {
      throw new Error(`Access for ${member.id} could not be updated.`);
    }

    return record;
  }

  private async syncNeutralTierRoles(member: GuildMember, tier: Tier | null): Promise<void> {
    const roleIds = Object.values(this.appConfig.roleIds.network);
    const legacyRoleIds = [
      ...Object.values(this.appConfig.roleIds.legacy.client),
      ...Object.values(this.appConfig.roleIds.legacy.dev)
    ].filter((roleId): roleId is string => Boolean(roleId));

    const removableRoleIds = [...new Set([...roleIds, ...legacyRoleIds])];
    const managedRoles = removableRoleIds.filter((roleId) => member.roles.cache.has(roleId));
    if (managedRoles.length > 0) {
      await member.roles.remove(managedRoles).catch(() => undefined);
    }

    if (!tier) {
      return;
    }

    const targetRoleId = this.appConfig.roleIds.network[tier];
    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
      await member.roles.add(targetRoleId).catch(() => undefined);
    }
  }
}
