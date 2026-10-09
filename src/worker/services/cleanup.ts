import type { AppDatabase } from "../../db/client";
import { purgeAttachments, type AttachmentBucket, type PurgeAttachmentsResult } from "./attachments";
import { purgeExpiredDeleted, type PurgeExpiredDeletedResult } from "./tasks";

export type DailyCleanupResult = {
	attachments: PurgeAttachmentsResult | { error: string };
	recycleBin: PurgeExpiredDeletedResult | { skipped: string };
};

/**
 * 现有每日 03:00 cron（wrangler.json triggers.crons）的全部工作，按顺序：
 *  1) 附件清理（过期上传占位、待删 R2 对象、回收站到期任务的附件）；
 *  2) 回收站到期任务硬删（原有逻辑）。
 * 附件必须先清：任务行一删，FK cascade 会带走附件行，R2 key 就丢了。
 * 附件那步对到期任务的 R2 删除失败（或存储未绑定）时，本轮跳过任务硬删，明天重试。
 */
export async function runDailyCleanup(
	db: AppDatabase,
	bucket: AttachmentBucket | undefined | null,
	now = new Date(),
): Promise<DailyCleanupResult> {
	let attachments: DailyCleanupResult["attachments"];
	let blockTaskPurge = false;
	try {
		attachments = await purgeAttachments(db, bucket, { now });
		blockTaskPurge = attachments.blockTaskPurge;
	} catch (error) {
		console.error("attachments purge failed", error);
		attachments = { error: error instanceof Error ? error.message : String(error) };
		blockTaskPurge = true;
	}
	const recycleBin = blockTaskPurge
		? { skipped: "attachment cleanup failed; retry next run" }
		: await purgeExpiredDeleted(db, now);
	return { attachments, recycleBin };
}
