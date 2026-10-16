/**
 * Settings repository - key/value storage for runtime configuration.
 */

import { DEFAULT_TENANT_ID } from "@server/tenancy/constants";
import type { settingsRegistry } from "@shared/settings-registry";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index";
import {
  getPrivateDataScope,
  privateDataScopeFilter,
} from "../tenancy/private-scope";

const { settings } = schema;

function settingsScopeFilter() {
  return privateDataScopeFilter(settings);
}

export type SettingKey = Exclude<
  {
    [K in keyof typeof settingsRegistry]: (typeof settingsRegistry)[K]["kind"] extends "virtual"
      ? never
      : K;
  }[keyof typeof settingsRegistry],
  undefined
>;

export async function getSetting(key: SettingKey): Promise<string | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(settingsScopeFilter(), eq(settings.key, key)));
  return row?.value ?? null;
}

export async function getAllSettings(): Promise<
  Partial<Record<SettingKey, string>>
> {
  const rows = await db.select().from(settings).where(settingsScopeFilter());
  return rows.reduce(
    (acc, row) => {
      acc[row.key as SettingKey] = row.value;
      return acc;
    },
    {} as Partial<Record<SettingKey, string>>,
  );
}

export async function setSetting(
  key: SettingKey,
  value: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const scope = getPrivateDataScope();

  if (value === null) {
    await db
      .delete(settings)
      .where(and(settingsScopeFilter(), eq(settings.key, key)));
    return;
  }

  const [existing] = await db
    .select({ key: settings.key })
    .from(settings)
    .where(and(settingsScopeFilter(), eq(settings.key, key)));

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(and(settingsScopeFilter(), eq(settings.key, key)));
    return;
  }

  await db.insert(settings).values({
    tenantId: scope.tenantId,
    userId: scope.userId,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Operator-level settings: one row per key, keyed `(DEFAULT_TENANT_ID, user_id IS NULL)`.
 * Deliberately not scoped to the caller's workspace, so every administrator and every
 * workspace reads and updates the same value. `settings` is key/value, so each key is its
 * own row.
 */
function operatorSettingFilter(key: SettingKey) {
  return and(
    eq(settings.tenantId, DEFAULT_TENANT_ID),
    isNull(settings.userId),
    eq(settings.key, key),
  );
}

export async function getOperatorSetting(
  key: SettingKey,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(operatorSettingFilter(key));
  return row?.value ?? null;
}

export async function setOperatorSetting(
  key: SettingKey,
  value: string | null,
): Promise<void> {
  const now = new Date().toISOString();

  if (value === null) {
    await db.delete(settings).where(operatorSettingFilter(key));
    return;
  }

  const [existing] = await db
    .select({ key: settings.key })
    .from(settings)
    .where(operatorSettingFilter(key));

  if (existing) {
    await db
      .update(settings)
      .set({ value, updatedAt: now })
      .where(operatorSettingFilter(key));
    return;
  }

  await db.insert(settings).values({
    tenantId: DEFAULT_TENANT_ID,
    userId: null,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  });
}
