import { z } from "zod";

const envSchema = z.object({
    PROXY_LIST_URL: z.string().optional(),
    PORT: z.coerce.number(),
    POSTHOG_KEY: z.string().min(1),
    POSTHOG_HOST: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;

const myEnv = envSchema.parse(process.env);

export default myEnv;
