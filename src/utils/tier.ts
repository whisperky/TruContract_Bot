import type { Tier } from "../domain/models.js";

const ACCESS_ORDER: readonly Tier[] = ["gold", "silver", "copper"];
const ELIGIBLE_ORDER: readonly Tier[] = ["copper", "silver", "gold"];

export function getAccessibleMarketTiers(accountTier: Tier): Tier[] {
  const index = ACCESS_ORDER.indexOf(accountTier);
  if (index === -1) {
    return [];
  }

  return [...ACCESS_ORDER.slice(index)];
}

export function getEligibleAccountTiersForMarket(marketTier: Tier): Tier[] {
  const index = ELIGIBLE_ORDER.indexOf(marketTier);
  if (index === -1) {
    return [];
  }

  return [...ELIGIBLE_ORDER.slice(index)];
}

export function canAccessMarket(accountTier: Tier, marketTier: Tier): boolean {
  return getAccessibleMarketTiers(accountTier).includes(marketTier);
}

export function getTierLabel(tier: Tier): string {
  switch (tier) {
    case "gold":
      return "Gold";
    case "silver":
      return "Silver";
    case "copper":
      return "Bronze";
  }
}
