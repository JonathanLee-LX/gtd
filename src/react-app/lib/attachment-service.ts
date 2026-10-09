/**
 * #68 前端附件服务：组件只调这里，不直接拼接口。
 * 上传 = 本地校验 → request（服务端再校验 + 占位）→ PUT 字节（带进度）→ confirm。
 */
import {
	resolveAttachmentMime,
	validateAttachmentFile,
	type AttachmentValidationError,
} from "../../shared/limits";
import { api, ApiError, type Attachment } from "../api";

export class AttachmentValidationFailure extends Error {
	constructor(public readonly detail: AttachmentValidationError) {
		super(detail.message);
		this.name = "AttachmentValidationFailure";
	}
}

export type UploadProgress = { loaded: number; total: number };

/** PUT 字节到同源上传地址。用 XHR 是为了拿上传进度（fetch 拿不到）。 */
export type PutBytes = (
	url: string,
	file: Blob,
	headers: Record<string, string>,
	onProgress?: (progress: UploadProgress) => void,
) => Promise<void>;

export const xhrPutBytes: PutBytes = (url, file, headers, onProgress) =>
	new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.withCredentials = true;
		for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
				return;
			}
			let message = `上传失败 (${xhr.status})`;
			let code: string | undefined;
			try {
				const data = JSON.parse(xhr.responseText) as { message?: string; error?: string };
				message = data.message || message;
				code = data.error;
			} catch {
				// 非 JSON 响应，用默认文案
			}
			reject(new ApiError(message, xhr.status, code));
		};
		xhr.onerror = () => reject(new ApiError("网络异常，上传失败，请重试", 0, "network"));
		xhr.onabort = () => reject(new ApiError("上传已取消", 0, "aborted"));
		xhr.send(file);
	});

/** 选文件后、发任何请求前的校验。不通过直接抛 AttachmentValidationFailure。 */
export function assertUploadable(file: File, existingCount: number) {
	const problem = validateAttachmentFile(file, existingCount);
	if (problem) throw new AttachmentValidationFailure(problem);
}

export const attachmentService = {
	list: (taskId: string) => api.taskAttachments(taskId),

	async upload(
		taskId: string,
		file: File,
		options: {
			existingCount: number;
			onProgress?: (progress: UploadProgress) => void;
			putBytes?: PutBytes;
		},
	): Promise<Attachment> {
		assertUploadable(file, options.existingCount);
		const mime = resolveAttachmentMime(file.name, file.type) ?? file.type;
		const ticket = await api.requestAttachmentUpload(taskId, {
			fileName: file.name,
			size: file.size,
			mime,
		});
		await (options.putBytes ?? xhrPutBytes)(ticket.uploadUrl, file, ticket.headers, options.onProgress);
		const { attachment } = await api.confirmAttachmentUpload(taskId, ticket.uploadId);
		return attachment;
	},

	remove: (taskId: string, attachmentId: string) => api.deleteAttachment(taskId, attachmentId),

	downloadUrl: (attachment: Pick<Attachment, "contentUrl">) => `${attachment.contentUrl}?download=1`,
};

export const attachmentKeys = {
	all: ["attachments"] as const,
	task: (taskId: string) => [...attachmentKeys.all, taskId] as const,
};
