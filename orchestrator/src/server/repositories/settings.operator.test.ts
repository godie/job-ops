import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRequestContext } from "@infra/request-context";
import { ADMIN_ONLY_SETTING_KEYS } from "@shared/settings-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("operator-level settings scope", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let settingsRepo: Awaited<typeof import("./settings")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-operator-settings-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    settingsRepo = await import("./settings");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const asAdministrator = <T>(
    tenantId: string,
    userId: string,
    fn: () => Promise<T>,
  ) => runWithRequestContext({ requestId: "test", tenantId, userId }, fn);

  it("shares both keys between administrators in different workspaces", async () => {
    await asAdministrator("tenant-a", "admin-a", () =>
      settingsRepo.setOperatorSetting("opencodeUrl", "https://one.example.com"),
    );
    await asAdministrator("tenant-b", "admin-b", () =>
      settingsRepo.setOperatorSetting("opencodePassword", "secret-from-b"),
    );

    const rows = (await db.select().from(schema.settings)).filter((row) =>
      row.key.startsWith("opencode"),
    );
    // One row per key, both in the operator scope rather than the caller's workspace.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.key).sort()).toEqual([
      "opencodePassword",
      "opencodeUrl",
    ]);
    for (const row of rows) {
      expect(row.tenantId).toBe("tenant_default");
      expect(row.userId).toBeNull();
    }

    // Either administrator reads both keys, from whichever workspace.
    const readAsSecond = await asAdministrator(
      "tenant-b",
      "admin-b",
      async () => ({
        url: await settingsRepo.getOperatorSetting("opencodeUrl"),
        password: await settingsRepo.getOperatorSetting("opencodePassword"),
      }),
    );
    expect(readAsSecond).toEqual({
      url: "https://one.example.com",
      password: "secret-from-b",
    });

    // No write lands under a caller's user_id.
    const allRows = await db.select().from(schema.settings);
    expect(
      allRows.some(
        (row) => row.userId === "admin-a" || row.userId === "admin-b",
      ),
    ).toBe(false);

    // Clearing removes the override for everyone.
    await asAdministrator("tenant-a", "admin-a", () =>
      settingsRepo.setOperatorSetting("opencodeUrl", null),
    );
    expect(
      await asAdministrator("tenant-b", "admin-b", () =>
        settingsRepo.getOperatorSetting("opencodeUrl"),
      ),
    ).toBeNull();
  });

  it("reserves both keys for administrators", () => {
    expect(ADMIN_ONLY_SETTING_KEYS.has("opencodeUrl")).toBe(true);
    expect(ADMIN_ONLY_SETTING_KEYS.has("opencodePassword")).toBe(true);
  });

  it("keeps an omitted field, updates only the field sent, and clears on an empty value", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "job-ops-opencode-state-"));
    process.env.XDG_STATE_HOME = stateDir;
    process.env.OPENCODE_PASSWORD = "env-pw";
    await mkdir(join(stateDir, "opencode"), { recursive: true });
    await writeFile(
      join(stateDir, "opencode", "service.json"),
      JSON.stringify({ url: "http://127.0.0.1:5123", password: "file-pw" }),
    );

    const { applySettingsUpdates } = await import(
      "../services/settings-update/apply-updates"
    );
    const { resolveOpenCodeEndpoint } = await import(
      "../services/llm/opencode/service"
    );
    const resolveAsOtherAdmin = () =>
      asAdministrator("tenant-b", "admin-b", () => resolveOpenCodeEndpoint());

    try {
      // Save both fields.
      await asAdministrator("tenant-a", "admin-a", () =>
        applySettingsUpdates({
          opencodeUrl: "https://stored.example.com",
          opencodePassword: "stored-pw",
        }),
      );
      expect(await resolveAsOtherAdmin()).toEqual({
        baseUrl: "https://stored.example.com",
        password: "stored-pw",
      });

      // Update only the URL: the password is untouched.
      await asAdministrator("tenant-a", "admin-a", () =>
        applySettingsUpdates({ opencodeUrl: "https://second.example.com" }),
      );
      expect(await resolveAsOtherAdmin()).toEqual({
        baseUrl: "https://second.example.com",
        password: "stored-pw",
      });

      // Clear the URL: it falls back to the registration file, not the environment.
      await asAdministrator("tenant-a", "admin-a", () =>
        applySettingsUpdates({ opencodeUrl: "" }),
      );
      expect(await resolveAsOtherAdmin()).toEqual({
        baseUrl: "http://127.0.0.1:5123",
        password: "stored-pw",
      });

      // Clear the password: with no registration-file password, the environment applies.
      await asAdministrator("tenant-a", "admin-a", () =>
        applySettingsUpdates({ opencodePassword: null }),
      );
      expect(await resolveAsOtherAdmin()).toEqual({
        baseUrl: "http://127.0.0.1:5123",
        password: "file-pw",
      });
    } finally {
      delete process.env.XDG_STATE_HOME;
      delete process.env.OPENCODE_PASSWORD;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
