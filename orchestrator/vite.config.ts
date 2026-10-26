/// <reference types="vitest" />

import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vite";

function readAppVersion(): string {
  const packageJsonPath = new URL("./package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (
    typeof packageJson.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(packageJson.version)
  ) {
    throw new Error(
      "orchestrator/package.json must contain a semver version in x.y.z format",
    );
  }

  return `v${packageJson.version}`;
}

const appVersion = readAppVersion();

declare global {
  // eslint-disable-next-line no-var
  var __APP_VERSION__: string;
}

export default defineConfig(({ mode }) => {
  // Reuse the root .env (same file the server loads) so dev ports are configurable.
  // Vitest loads this same config with mode "test"; skipping the file there keeps
  // the developer's credentials out of `process.env`. CI has no .env, so tests
  // must pass without one.
  if (mode !== "test") {
    loadDotenv({ path: path.resolve(__dirname, "..", ".env") });
  }

  const apiPort = process.env.PORT || "3001";
  const webPort = Number(process.env.WEB_PORT || "5173");

  return {
    plugins: [react(), tailwindcss()],
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/setupTests.ts",
      pool: "forks",
      maxWorkers: 4,
      testTimeout: 60_000,
      hookTimeout: 60_000,
      include: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "../docs-site/src/**/*.test.ts",
        "../docs-site/src/**/*.test.tsx",
        "../career-boards/**/*.test.ts",
        "../shared/src/**/*.test.ts",
        "../extractors/**/tests/**/*.test.ts",
        "../visa-sponsor-providers/**/*.test.ts",
      ],
      exclude: ["node_modules/**", "dist/**"],
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@client": path.resolve(__dirname, "./src/client"),
        "@server": path.resolve(__dirname, "./src/server"),
        "@infra": path.resolve(__dirname, "./src/server/infra"),
        "@shared": path.resolve(__dirname, "../shared/src"),
        "job-ops-shared": path.resolve(__dirname, "../shared/src"),
        "@career-boards/bamboohr": path.resolve(
          __dirname,
          "../career-boards/bamboohr/src/index.ts",
        ),
        "@career-boards/workday": path.resolve(
          __dirname,
          "../career-boards/workday/src/index.ts",
        ),
        "@career-boards/greenhouse": path.resolve(
          __dirname,
          "../career-boards/greenhouse/src/index.ts",
        ),
      },
    },
    server: {
      // Bind to all interfaces so the dev server is reachable on the LAN.
      host: true,
      port: webPort,
      proxy: {
        "/api": {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        "/pdfs": {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        "/stats": {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
  };
});
