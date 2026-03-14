import myEnv from "./myEnv";

import type { ProxySelection } from "./db";

type PostHogClient = {
    capture: (input: {
        distinctId: string;
        event: string;
        properties?: Record<string, unknown>;
    }) => void;
    flush: () => Promise<void>;
};

const posthogClient: PostHogClient | null =
    process.env.NODE_ENV === "test"
        ? null
        : new (await import("posthog-node")).PostHog(myEnv.POSTHOG_KEY, {
              host: myEnv.POSTHOG_HOST,
              flushAt: 1,
              flushInterval: 0,
          });

const capture = (
    distinctId: string,
    event: string,
    properties?: Record<string, unknown>,
) => {
    if (!posthogClient) {
        return;
    }

    posthogClient.capture({ distinctId, event, properties });
};

export const posthog = { capture, client: posthogClient };

export const captureProxyStatusEvent = async (
    proxy: ProxySelection,
    status: "success" | "error",
) => {
    const event = status === "success" ? "proxy_success" : "proxy_error";

    if (!posthogClient) {
        return;
    }

    try {
        capture(proxy.id, event, {
            distinct_id: proxy.id,
            proxyId: proxy.id,
            proxyIp: proxy.conn.ip,
            proxyPort: proxy.conn.port,
            status,
            score: proxy.score,
            uptime: proxy.uptime,
            successCount: proxy.successCount,
            failureCount: proxy.failureCount,
            requestsCount: proxy.requestsCount,
            consecutiveFailures: proxy.consecutiveFailures,
            cooldownUntil: proxy.cooldownUntil,
        });
        await posthogClient.flush();
    } catch (error) {
        console.error("Failed to send proxy event to PostHog", error);
    }
};

export default posthog;
