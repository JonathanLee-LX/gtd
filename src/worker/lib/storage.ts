import type { WorkerEnv } from "./auth";

/**
 * #68：附件存储绑定。单独声明，避免改动 auth.ts 里的 WorkerEnv。
 * 生产桶 `gtd-uploads`，wrangler.json 里绑定为 `UPLOADS`。
 */
export type AppEnv = WorkerEnv & {
	UPLOADS: R2Bucket;
};
