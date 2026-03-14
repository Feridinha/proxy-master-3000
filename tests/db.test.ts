import { describe, expect, test } from "bun:test";

import * as fs from "fs";
import * as path from "path";

import { pathToFileURL } from "url";

import type { ProxyData } from "../src/db";

type DbModule = typeof import("../src/db");

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const DB_SOURCE_PATH = path.resolve(import.meta.dir, "../src/db.ts");
const POSTHOG_SOURCE_PATH = path.resolve(import.meta.dir, "../src/posthog.ts");
const ENV_SOURCE_PATH = path.resolve(import.meta.dir, "../src/myEnv.ts");

const withIsolatedDb = async (
    {
        proxyLines,
        persistedProxies = {},
        env = {},
        randomImpl,
    }: {
        proxyLines: string[];
        persistedProxies?: Record<string, Partial<ProxyData>>;
        env?: Record<string, string>;
        randomImpl?: () => number;
    },
    run: (db: DbModule) => Promise<void>,
) => {
    const tempDir = fs.mkdtempSync(path.join(REPO_ROOT, ".proxy-master-3000-test-"));
    const previousCwd = process.cwd();
    const tempDbPath = path.join(tempDir, "db-under-test.ts");
    const previousEnv = {
        NODE_ENV: process.env.NODE_ENV,
        PORT: process.env.PORT,
        POSTHOG_KEY: process.env.POSTHOG_KEY,
        POSTHOG_HOST: process.env.POSTHOG_HOST,
    };
    const originalRandom = Math.random;

    fs.writeFileSync(path.join(tempDir, "proxies.txt"), `${proxyLines.join("\n")}\n`);
    fs.writeFileSync(
        path.join(tempDir, "proxies.json"),
        JSON.stringify(persistedProxies, null, 2),
    );
    fs.copyFileSync(DB_SOURCE_PATH, tempDbPath);
    fs.copyFileSync(POSTHOG_SOURCE_PATH, path.join(tempDir, "posthog.ts"));
    fs.copyFileSync(ENV_SOURCE_PATH, path.join(tempDir, "myEnv.ts"));

    process.env.NODE_ENV = env.NODE_ENV ?? "test";
    process.env.PORT = env.PORT ?? "60888";
    process.env.POSTHOG_KEY = env.POSTHOG_KEY ?? "test-posthog-key";
    process.env.POSTHOG_HOST = env.POSTHOG_HOST ?? "https://us.posthog.com";
    Math.random = randomImpl ?? originalRandom;

    process.chdir(tempDir);

    try {
        const db = await import(pathToFileURL(tempDbPath).href);
        await run(db);
    } finally {
        process.env.NODE_ENV = previousEnv.NODE_ENV;
        process.env.PORT = previousEnv.PORT;
        process.env.POSTHOG_KEY = previousEnv.POSTHOG_KEY;
        process.env.POSTHOG_HOST = previousEnv.POSTHOG_HOST;
        Math.random = originalRandom;
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
};

describe("proxy score selection", () => {
    test("stable strategy picks the highest scoring proxy", async () => {
        const bestProxyId = "10.0.0.1:8000:user-a:pass-a";
        const weakerProxyId = "10.0.0.2:8000:user-b:pass-b";

        await withIsolatedDb(
            {
                proxyLines: [bestProxyId, weakerProxyId],
                persistedProxies: {
                    [bestProxyId]: {
                        successCount: 7,
                        failureCount: 1,
                    },
                    [weakerProxyId]: {
                        successCount: 4,
                        failureCount: 4,
                    },
                },
            },
            async ({ getProxy }) => {
                const selected = getProxy("stable");

                expect(selected?.id).toBe(bestProxyId);
                expect(selected?.score).toBe(88);
            },
        );
    });

    test("stable strategy switches to another proxy after errors tank the score", async () => {
        const degradedProxyId = "10.0.0.3:8000:user-c:pass-c";
        const healthyProxyId = "10.0.0.4:8000:user-d:pass-d";

        await withIsolatedDb(
            {
                proxyLines: [degradedProxyId, healthyProxyId],
            },
            async ({ getProxy, reportProxyStatus }) => {
                expect(getProxy("stable")?.id).toBe(degradedProxyId);

                const afterError = reportProxyStatus(degradedProxyId, "error");
                expect(afterError?.score).toBe(0);

                const selected = getProxy("stable");

                expect(selected?.id).toBe(healthyProxyId);
                expect(selected?.score).toBe(100);
            },
        );
    });

    test("a success report clears the failure penalty so a recovered proxy becomes best again", async () => {
        const recoveringProxyId = "10.0.0.5:8000:user-e:pass-e";
        const runnerUpProxyId = "10.0.0.6:8000:user-f:pass-f";

        await withIsolatedDb(
            {
                proxyLines: [recoveringProxyId, runnerUpProxyId],
                persistedProxies: {
                    [recoveringProxyId]: {
                        successCount: 9,
                        failureCount: 2,
                        consecutiveFailures: 2,
                        lastFailureAt: "2026-03-14T12:00:00.000Z",
                    },
                    [runnerUpProxyId]: {
                        successCount: 3,
                        failureCount: 1,
                    },
                },
            },
            async ({ getProxy, reportProxyStatus }) => {
                expect(getProxy("stable")?.id).toBe(runnerUpProxyId);

                const recovered = reportProxyStatus(recoveringProxyId, "success");

                expect(recovered?.consecutiveFailures).toBe(0);
                expect(recovered?.score).toBe(83);
                expect(recovered?.cooldownUntil).toBeNull();

                const selected = getProxy("stable");
                expect(selected?.id).toBe(recoveringProxyId);
                expect(selected?.score).toBe(83);
            },
        );
    });

    test("updates proxy metrics with PostHog disabled during tests", async () => {
        const proxyId = "10.0.0.7:8000:user-g:pass-g";

        await withIsolatedDb(
            {
                proxyLines: [proxyId],
            },
            async ({ reportProxyStatus }) => {
                const success = reportProxyStatus(proxyId, "success");
                const error = reportProxyStatus(proxyId, "error");

                expect(success).not.toBeNull();
                expect(success?.score).toBe(100);
                expect(success?.successCount).toBe(1);
                expect(success?.failureCount).toBe(0);
                expect(success?.consecutiveFailures).toBe(0);

                expect(error).not.toBeNull();
                expect(error?.score).toBe(35);
                expect(error?.uptime).toBe(0.5);
                expect(error?.successCount).toBe(1);
                expect(error?.failureCount).toBe(1);
                expect(error?.consecutiveFailures).toBe(1);
            },
        );
    });

    test("balanced strategy favors healthier proxies over 1000 requests", async () => {
        const healthyProxyId = "10.0.0.8:8000:user-h:pass-h";
        const flakyProxyId = "10.0.0.9:8000:user-i:pass-i";
        const failingProxyId = "10.0.0.10:8000:user-j:pass-j";
        const selectionCounts = {
            [healthyProxyId]: 0,
            [flakyProxyId]: 0,
            [failingProxyId]: 0,
        };
        let seed = 13;
        const randomImpl = () => {
            seed = (seed * 48271) % 0x7fffffff;
            return seed / 0x7fffffff;
        };

        await withIsolatedDb(
            {
                proxyLines: [healthyProxyId, flakyProxyId, failingProxyId],
                randomImpl,
            },
            async ({ getProxy, reportProxyStatus }) => {
                for (let requestIndex = 0; requestIndex < 1000; requestIndex += 1) {
                    const selected = getProxy("balanced");

                    expect(selected).not.toBeNull();
                    if (!selected) {
                        continue;
                    }

                    selectionCounts[selected.id as keyof typeof selectionCounts] += 1;

                    if (selected.id === healthyProxyId) {
                        reportProxyStatus(selected.id, "success");
                        continue;
                    }

                    if (selected.id === flakyProxyId) {
                        const status = requestIndex % 4 === 0 ? "error" : "success";
                        reportProxyStatus(selected.id, status);
                        continue;
                    }

                    reportProxyStatus(selected.id, "error");
                }

                const stableSelection = getProxy("stable");
                expect(stableSelection?.id).toBe(healthyProxyId);
            },
        );

        console.log(
            "balanced 1000-request distribution",
            JSON.stringify(selectionCounts),
        );
        expect(selectionCounts[healthyProxyId]).toBeGreaterThan(950);
        expect(selectionCounts[flakyProxyId]).toBeGreaterThan(10);
        expect(selectionCounts[flakyProxyId]).toBeLessThan(50);
        expect(selectionCounts[failingProxyId]).toBeLessThan(10);
        expect(selectionCounts[healthyProxyId]).toBeGreaterThan(
            selectionCounts[flakyProxyId],
        );
        expect(selectionCounts[flakyProxyId]).toBeGreaterThan(
            selectionCounts[failingProxyId],
        );
    });
});
