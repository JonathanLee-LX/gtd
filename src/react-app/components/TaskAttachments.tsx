import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { DownloadIcon, FileTextIcon, ImageIcon, PaperclipIcon, TrashIcon } from "lucide-react";
import {
	ATTACHMENT_INPUT_ACCEPT,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_TASK,
	formatFileSize,
	formatLimitBytes,
	isInlineImageMime,
	validateAttachmentFile,
} from "../../shared/limits";
import type { Attachment } from "../api";
import { attachmentKeys, attachmentService } from "../lib/attachment-service";
import { useSkeletonCount } from "../hooks/use-skeleton";
import { SkeletonList } from "./SkeletonList";
// TEMP #89 diagnostics — remove after root cause found
import { startPickerWatch, watchInterceptedClicks, type PickerWatch } from "../lib/picker-diagnostics";

type UploadItem = {
	key: string;
	name: string;
	size: number;
	loaded: number;
	error?: string;
};

function attachmentName(item: Attachment) {
	return item.fileName || (item.kind === "image" ? "图片" : "文件");
}

/** 文件类型短标签：PDF / HEIC / JPG…（缩略图加载失败时显示在图标下）。 */
function typeLabel(item: Attachment) {
	const sub = (item.mime ?? "").split("/")[1] ?? "";
	if (sub === "pdf") return "PDF";
	if (sub === "jpeg") return "JPG";
	return sub ? sub.toUpperCase().slice(0, 4) : "文件";
}

/**
 * 附件列表的一行。#99：`skeleton` 变体复用同一个 li / 缩略图 / 名称 / 大小 / 操作按钮结构，
 * 尺寸和真实行一致，只是画成灰块、不可交互。
 */
/** 真实行和骨架行共用的尺寸类，改一处两边一起变。 */
const ROW_CLASS = "flex min-w-0 items-center gap-3 rounded-lg border p-2";
const TILE_CLASS = "size-14 shrink-0 rounded-md border";
const NAME_CLASS = "truncate text-sm";
const META_CLASS = "flex items-center gap-1 text-xs";
const ACTION_CLASS = buttonVariants({ variant: "ghost", size: "icon" });

function AttachmentRow(
	props:
		| {
				skeleton?: false;
				item: Attachment;
				thumbBroken: boolean;
				onPreview: () => void;
				onDelete: () => void;
				onThumbError: () => void;
		  }
		| { skeleton: true },
) {
	if (props.skeleton) {
		return (
			<li aria-hidden className={ROW_CLASS} data-skeleton="">
				<span className={cn(TILE_CLASS, "skeleton-fill")} />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className={cn(NAME_CLASS, "skeleton-fill w-fit max-w-full rounded-sm")}>附件文件名称.jpg</span>
					<span className={cn(META_CLASS, "skeleton-fill w-fit rounded-sm")}>
						<ImageIcon className="size-3" />
						1.2 MB
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<span className={cn(ACTION_CLASS, "skeleton-fill")} />
					<span className={cn(ACTION_CLASS, "skeleton-fill")} />
				</div>
			</li>
		);
	}
	const { item, thumbBroken, onPreview, onDelete, onThumbError } = props;
	const name = attachmentName(item);
	const isImage = item.kind === "image" && isInlineImageMime(item.mime);
	const TileIcon = isImage ? ImageIcon : FileTextIcon;
	return (
		<li className={ROW_CLASS}>
			{isImage ? (
				<button
					type="button"
					className={cn(TILE_CLASS, "overflow-hidden bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none")}
					onClick={onPreview}
					aria-label={`预览 ${name}`}
				>
					{thumbBroken ? (
						<span className="flex size-full flex-col items-center justify-center gap-0.5 text-muted-foreground">
							<ImageIcon className="size-6" />
							<span className="text-[10px] font-medium">{typeLabel(item)}</span>
						</span>
					) : (
						<img
							src={item.contentUrl}
							alt={name}
							loading="lazy"
							className="size-full object-cover"
							onError={onThumbError}
						/>
					)}
				</button>
			) : (
				<a
					href={item.contentUrl}
					target="_blank"
					rel="noopener"
					className={cn(TILE_CLASS, "flex flex-col items-center justify-center gap-0.5 bg-muted text-muted-foreground hover:text-foreground")}
					aria-label={`打开 ${name}`}
				>
					<TileIcon className="size-6" />
					<span className="text-[10px] font-medium">{typeLabel(item)}</span>
				</a>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{isImage ? (
					<button
						type="button"
						className={cn(NAME_CLASS, "text-left hover:underline")}
						onClick={onPreview}
					>
						{name}
					</button>
				) : (
					<a
						href={item.contentUrl}
						target="_blank"
						rel="noopener"
						className={cn(NAME_CLASS, "hover:underline")}
					>
						{name}
					</a>
				)}
				<span className={cn(META_CLASS, "text-muted-foreground")}>
					{isImage ? <ImageIcon className="size-3" /> : <FileTextIcon className="size-3" />}
					{formatFileSize(item.size)}
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				<a
					href={attachmentService.downloadUrl(item)}
					download={name}
					className={ACTION_CLASS}
					aria-label={`下载 ${name}`}
					title="下载"
				>
					<DownloadIcon />
				</a>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label={`删除 ${name}`}
					title="删除"
					onClick={onDelete}
				>
					<TrashIcon />
				</Button>
			</div>
		</li>
	);
}

/**
 * 任务详情里的附件区（#68）：上传（手机可拍照 / 相册 / 文件）、列表、图片缩略图 + 大图预览、
 * PDF 新标签打开、下载、确认后删除。读写都走 attachmentService，后端按 user_id 隔离。
 */
export function TaskAttachments({ taskId }: { taskId: string }) {
	const queryClient = useQueryClient();
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Attachment | null>(null);
	const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [dragOver, setDragOver] = useState(false);
	// 浏览器渲染不了的图片（Chrome / Android / Windows 上的 HEIC 等）：退回文件图标，下载照常。
	const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());
	const markBroken = (id: string) =>
		setBrokenImages((current) => (current.has(id) ? current : new Set(current).add(id)));

	// TEMP #89 diagnostics — remove after root cause found
	const pickerLabelRef = useRef<HTMLLabelElement>(null);
	const pickerInputRef = useRef<HTMLInputElement>(null);
	const pickerWatchRef = useRef<PickerWatch | null>(null);
	const isTempTaskRef = useRef(taskId.startsWith("tmp-"));
	isTempTaskRef.current = taskId.startsWith("tmp-");
	useEffect(() => {
		const stopIntercept = watchInterceptedClicks({
			getLabel: () => pickerLabelRef.current,
			getInput: () => pickerInputRef.current,
			isTempTask: () => isTempTaskRef.current,
		});
		return () => {
			stopIntercept();
			pickerWatchRef.current?.stop();
			pickerWatchRef.current = null;
		};
	}, []);

	const query = useQuery({
		queryKey: attachmentKeys.task(taskId),
		queryFn: () => attachmentService.list(taskId),
	});
	const items = query.data?.items ?? [];
	// #99：附件按任务记条数。没记录时默认 1 行（多数任务没有附件，5 行灰块会比「还没有附件。」高出一大截）。
	const skeletonCount = useSkeletonCount({
		storageKey: attachmentKeys.task(taskId),
		loading: query.isPending,
		loadedCount: items.length,
		max: MAX_ATTACHMENTS_PER_TASK,
		fallback: 1,
	});
	const uploading = uploads.some((item) => !item.error);
	const pickerDisabled = uploading || items.length >= MAX_ATTACHMENTS_PER_TASK;

	function patchUpload(key: string, patch: Partial<UploadItem>) {
		setUploads((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
	}

	async function handleFiles(fileList: FileList | File[] | null) {
		const files = Array.from(fileList ?? []);
		if (files.length === 0) return;
		setError(null);
		setUploads((current) => current.filter((item) => !item.error));

		// 上传前先整体校验：类型 / 大小 / 单任务数量，任何一个不过都不发请求。
		const problems: string[] = [];
		const accepted: File[] = [];
		for (const file of files) {
			const problem = validateAttachmentFile(file, items.length + accepted.length);
			if (problem) problems.push(problem.message);
			else accepted.push(file);
		}
		if (problems.length > 0) {
			const message = problems.join("\n");
			setError(message);
			toast.error(problems.length === 1 ? problems[0] : `${problems.length} 个文件未上传`, {
				description: problems.length === 1 ? undefined : message,
			});
		}

		let count = items.length;
		for (const file of accepted) {
			const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
			setUploads((current) => [...current, { key, name: file.name, size: file.size, loaded: 0 }]);
			try {
				await attachmentService.upload(taskId, file, {
					existingCount: count,
					onProgress: ({ loaded }) => patchUpload(key, { loaded }),
				});
				count += 1;
				setUploads((current) => current.filter((item) => item.key !== key));
				await queryClient.invalidateQueries({ queryKey: attachmentKeys.task(taskId) });
			} catch (err) {
				const message = err instanceof Error ? err.message : "上传失败";
				patchUpload(key, { error: message });
				toast.error(`「${file.name}」上传失败`, { description: message });
			}
		}
	}

	async function confirmDelete() {
		if (!pendingDelete) return;
		setDeleting(true);
		try {
			await attachmentService.remove(taskId, pendingDelete.id);
			if (preview?.id === pendingDelete.id) setPreview(null);
			setPendingDelete(null);
			await queryClient.invalidateQueries({ queryKey: attachmentKeys.task(taskId) });
			toast.success("附件已删除");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "删除失败");
		} finally {
			setDeleting(false);
		}
	}

	return (
		<section
			aria-labelledby={`task-attachments-${taskId}`}
			data-testid="task-attachments"
			className={cn(
				"flex min-w-0 flex-col gap-2 rounded-lg",
				dragOver && "outline-2 outline-dashed outline-primary/60 outline-offset-4",
			)}
			onDragOver={(event) => {
				if (!event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				setDragOver(true);
			}}
			onDragLeave={() => setDragOver(false)}
			onDrop={(event) => {
				if (!event.dataTransfer.files.length) return;
				event.preventDefault();
				setDragOver(false);
				void handleFiles(event.dataTransfer.files);
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<p id={`task-attachments-${taskId}`} className="text-sm font-medium">
					附件
					<span className="ml-1.5 text-xs font-normal text-muted-foreground">
						{items.length}/{MAX_ATTACHMENTS_PER_TASK}
					</span>
				</p>
				{/*
				  #89：不用 JS 转发（button.onClick → input.click()）。整个可见「按钮」就是 <label>，
				  input 嵌在 label 里，用户点击由浏览器原生激活 file input，不依赖 ref / 用户激活传递，
				  各浏览器、WebView 行为一致。input 只做视觉隐藏（sr-only），不用 display:none / hidden。
				*/}
				<label
					ref={pickerLabelRef}
					data-testid="attachment-picker"
					onClick={(event) => {
						// TEMP #89 diagnostics — remove after root cause found
						const input = pickerInputRef.current;
						if (!input) return;
						// label 激活会再派发一次 click 到 input 并冒泡回来：已有观察就交给它记 inputClicked。
						if (event.target === input && pickerWatchRef.current?.active) return;
						pickerWatchRef.current?.stop();
						pickerWatchRef.current = startPickerWatch({
							label: event.currentTarget,
							input,
							click: event.nativeEvent,
							isTempTask: isTempTaskRef.current,
						});
					}}
					aria-disabled={pickerDisabled || undefined}
					className={cn(
						buttonVariants({ variant: "outline", size: "sm" }),
						"relative cursor-pointer has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
						pickerDisabled && "pointer-events-none cursor-not-allowed opacity-50",
					)}
				>
					{uploading ? <Spinner data-icon="inline-start" /> : <PaperclipIcon data-icon="inline-start" />}
					添加附件
					<input
						ref={pickerInputRef}
						type="file"
						accept={ATTACHMENT_INPUT_ACCEPT}
						multiple
						disabled={pickerDisabled}
						className="sr-only"
						aria-label="添加附件（图片或 PDF）"
						data-testid="attachment-input"
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							// 清空 value，同一个文件再选一次也会触发 change。
							event.target.value = "";
							void handleFiles(files);
						}}
					/>
				</label>
			</div>
			<p className="text-xs text-muted-foreground">
				图片或 PDF，单个不超过 {formatLimitBytes(MAX_ATTACHMENT_BYTES)}。手机上可直接拍照或从相册选。
			</p>

			{error ? (
				<p role="alert" className="whitespace-pre-line text-xs text-destructive">
					{error}
				</p>
			) : null}

			{uploads.length > 0 ? (
				<ul className="flex flex-col gap-1.5">
					{uploads.map((item) => {
						const percent = item.size > 0 ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : 0;
						return (
							<li key={item.key} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
								<div className="flex min-w-0 items-center justify-between gap-2 text-xs">
									<span className="truncate">{item.name}</span>
									<span className={cn("shrink-0", item.error ? "text-destructive" : "text-muted-foreground")}>
										{item.error ? "失败" : percent >= 100 ? "处理中…" : `${percent}%`}
									</span>
								</div>
								{item.error ? (
									<p className="text-xs text-destructive">{item.error}</p>
								) : (
									<div
										className="h-1.5 overflow-hidden rounded-full bg-muted"
										role="progressbar"
										aria-valuenow={percent}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`${item.name} 上传进度`}
									>
										<div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
									</div>
								)}
							</li>
						);
					})}
				</ul>
			) : null}

			{/* #99：冷加载骨架（150ms 后才出现），行数按任务记，缓存命中不出现。 */}
			<SkeletonList
				as="ul"
				loading={query.isPending}
				count={skeletonCount}
				label="正在加载附件"
				className="flex flex-col gap-1.5"
				renderItem={(index) => <AttachmentRow key={index} skeleton />}
			/>
			{query.isError ? (
				<p className="text-xs text-destructive">
					{query.error instanceof Error ? query.error.message : "加载附件失败"}
				</p>
			) : null}
			{query.isSuccess && items.length === 0 && uploads.length === 0 ? (
				<p className="text-xs text-muted-foreground">还没有附件。</p>
			) : null}

			{items.length > 0 ? (
				<ul className="flex flex-col gap-1.5" data-testid="attachment-list">
					{items.map((item) => (
						<AttachmentRow
							key={item.id}
							item={item}
							thumbBroken={brokenImages.has(item.id)}
							onPreview={() => setPreview(item)}
							onDelete={() => setPendingDelete(item)}
							onThumbError={() => markBroken(item.id)}
						/>
					))}
				</ul>
			) : null}

			<Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
				<DialogContent className="max-h-[90dvh] sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle className="truncate pr-8">{preview ? attachmentName(preview) : ""}</DialogTitle>
						<DialogDescription>{preview ? formatFileSize(preview.size) : ""}</DialogDescription>
					</DialogHeader>
					{preview && brokenImages.has(preview.id) ? (
						<div
							data-testid="attachment-preview-fallback"
							className="flex flex-col items-center justify-center gap-2 rounded-md border bg-muted px-4 py-10 text-center"
						>
							<ImageIcon className="size-10 text-muted-foreground" />
							<p className="text-sm">当前浏览器无法预览这种图片格式（{typeLabel(preview)}）。</p>
							<p className="text-xs text-muted-foreground">请下载后用系统相册或图片查看器打开。</p>
						</div>
					) : preview ? (
						<img
							src={preview.contentUrl}
							alt={attachmentName(preview)}
							className="max-h-[65dvh] w-full rounded-md object-contain"
							onError={() => markBroken(preview.id)}
						/>
					) : null}
					{preview ? (
						<div className="flex justify-end gap-2">
							<a
								href={attachmentService.downloadUrl(preview)}
								download={attachmentName(preview)}
								className={buttonVariants({ variant: "outline" })}
							>
								<DownloadIcon data-icon="inline-start" />
								下载
							</a>
						</div>
					) : null}
				</DialogContent>
			</Dialog>

			<AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>删除附件？</AlertDialogTitle>
						<AlertDialogDescription>
							将永久删除「{pendingDelete ? attachmentName(pendingDelete) : ""}」，文件不可恢复。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={deleting}
							onClick={(event) => {
								event.preventDefault();
								void confirmDelete();
							}}
						>
							{deleting ? <Spinner data-icon="inline-start" /> : null}
							确认删除
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
