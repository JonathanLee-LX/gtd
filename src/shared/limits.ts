/**
 * 附件（#68）的硬性额度与类型白名单，前后端共用同一份。
 *
 * 服务端是唯一权威：request / PUT / confirm / 代理下载都以这里为准；
 * 前端用它在选文件后、上传前做校验和提示，避免用户白传一遍才被拒。
 *
 * 迁移自 gtd-attach-exp 的 shared/limits.ts，v1 收窄：
 *  - 单文件 25MB → 10MB；
 *  - 只收图片 + PDF（不再是「任意文件」），视频 / 链接附件 v1 不开放。
 */

const BYTES_PER_MB = 1024 * 1024;

/** 单个文件大小上限：10MB。 */
export const MAX_ATTACHMENT_BYTES = 10 * BYTES_PER_MB;

/** 单个任务下附件数量上限：20 个。 */
export const MAX_ATTACHMENTS_PER_TASK = 20;

/** 单用户附件总占用上限：1GB。 */
export const MAX_USER_ATTACHMENT_BYTES = 1024 * BYTES_PER_MB;

/** 单用户附件数量上限：500 个。 */
export const MAX_USER_ATTACHMENT_COUNT = 500;

/** 上传占位（attachment_uploads.pending）有效期：15 分钟。过期由 cron 清理。 */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** 已删除附件在 cron 清理前的宽限：60 秒（避免与正在进行的删除请求撞车）。 */
export const ATTACHMENT_PURGE_GRACE_MS = 60 * 1000;

/** 展示用文件名长度上限（去掉路径后仍超长就截断）。 */
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

/** v1 附件类型：image 可内联预览，file 目前只有 PDF。 */
export const ATTACHMENT_KINDS = ["image", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** 允许的图片 MIME。SVG 是 XSS 载体，不收。HEIC/HEIF 来自 iPhone 相册。 */
export const ALLOWED_IMAGE_MIMES = [
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/avif",
] as const;

export const PDF_MIME = "application/pdf";

export const ALLOWED_ATTACHMENT_MIMES: readonly string[] = [...ALLOWED_IMAGE_MIMES, PDF_MIME];

/** `<input accept>`：image/* 让手机弹出「拍照 / 相册 / 文件」。 */
export const ATTACHMENT_INPUT_ACCEPT = "image/*,application/pdf";

const EXTENSION_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	heic: "image/heic",
	heif: "image/heif",
	avif: "image/avif",
	pdf: PDF_MIME,
};

export function normalizeMime(mime: string | null | undefined): string {
	const base = (mime ?? "").split(";")[0] ?? "";
	const normalized = base.trim().toLowerCase();
	return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

/**
 * 解析出允许的 MIME：优先用浏览器给的 type；为空（部分安卓文件管理器）时按扩展名兜底。
 * 返回 null 表示不支持。
 */
export function resolveAttachmentMime(fileName: string, mime: string | null | undefined): string | null {
	const normalized = normalizeMime(mime);
	if (normalized) {
		return ALLOWED_ATTACHMENT_MIMES.includes(normalized) ? normalized : null;
	}
	const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSION_MIME[ext] ?? null;
}

/** 能否用 `<img>` 内联预览（SVG 不在白名单里，天然排除）。 */
export function isInlineImageMime(mime: string | null | undefined): boolean {
	return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(normalizeMime(mime));
}

/** 由 MIME 推断 kind；不支持返回 null。 */
export function deriveUploadKind(mime: string): AttachmentKind | null {
	const normalized = normalizeMime(mime);
	if (isInlineImageMime(normalized)) return "image";
	if (normalized === PDF_MIME) return "file";
	return null;
}

export function formatLimitBytes(bytes: number): string {
	if (bytes >= BYTES_PER_MB && bytes % BYTES_PER_MB === 0) {
		return `${bytes / BYTES_PER_MB}MB`;
	}
	return `${bytes}B`;
}

export function formatFileSize(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < BYTES_PER_MB) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export type AttachmentValidationError = {
	code: "file_too_large" | "unsupported_type" | "empty_file" | "task_attachment_limit";
	message: string;
};

/**
 * 上传前校验（前端调用；服务端 request 阶段做同样的判断）。
 * `existingCount` 是该任务当前附件数，用于单任务配额。
 */
export function validateAttachmentFile(
	file: { name: string; size: number; type: string },
	existingCount = 0,
): AttachmentValidationError | null {
	if (existingCount >= MAX_ATTACHMENTS_PER_TASK) {
		return {
			code: "task_attachment_limit",
			message: `单个任务最多 ${MAX_ATTACHMENTS_PER_TASK} 个附件`,
		};
	}
	if (!resolveAttachmentMime(file.name, file.type)) {
		return {
			code: "unsupported_type",
			message: `「${file.name}」类型不支持，只能上传图片（JPG/PNG/GIF/WebP/HEIC）或 PDF`,
		};
	}
	if (file.size <= 0) {
		return { code: "empty_file", message: `「${file.name}」是空文件` };
	}
	if (file.size > MAX_ATTACHMENT_BYTES) {
		return {
			code: "file_too_large",
			message: `「${file.name}」有 ${formatFileSize(file.size)}，单个文件不能超过 ${formatLimitBytes(MAX_ATTACHMENT_BYTES)}`,
		};
	}
	return null;
}

/**
 * 按文件头确认真实类型（服务端 PUT 时用，不信客户端声明的 Content-Type）。
 * 返回识别出的 MIME，认不出返回 null。
 */
export function sniffAttachmentMime(head: Uint8Array): string | null {
	const at = (i: number) => head[i] ?? -1;
	const ascii = (start: number, text: string) =>
		[...text].every((ch, i) => at(start + i) === ch.charCodeAt(0));
	if (ascii(0, "%PDF-")) return PDF_MIME;
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
	if (at(0) === 0x89 && ascii(1, "PNG")) return "image/png";
	if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(4, "ftyp")) {
		const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
		if (brand === "avif" || brand === "avis") return "image/avif";
		if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
		if (brand === "mif1" || brand === "msf1") return "image/heif";
	}
	return null;
}
