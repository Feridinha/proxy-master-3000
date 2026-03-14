import myEnv from "./myEnv";

import type { ProxySelection } from "./db";

const buildCaptureUrl = () => {
    return new URL("/capture/", myEnv.POSTHOG_HOST).toString();
};

export const captureProxyStatusEvent = async (
    proxy: ProxySelection,
    status: "success" | "error",
) => {
    const event = status === "success" ? "proxy_success" : "proxy_error";

    try {
        await fetch(buildCaptureUrl(), {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                api_key: myEnv.POSTHOG_KEY,
                event,
                properties: {
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
                },
            }),
        });
    } catch (error) {
        console.error("Failed to send proxy event to PostHog", error);
    }
};
