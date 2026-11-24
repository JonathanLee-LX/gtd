import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

function isSafeUrl(url?: string): boolean {
	if (!url) return false;
	const trimmed = url.trim().toLowerCase();
	if (
		trimmed.startsWith("javascript:") ||
		trimmed.startsWith("vbscript:") ||
		trimmed.startsWith("data:")
	) {
		return false;
	}
	return true;
}

const markdownComponents: Components = {
	h1: ({ node: _node, className, ...props }) => (
		<h1
			className={cn("text-lg font-bold mt-4 mb-2 first:mt-0 text-foreground", className)}
			{...props}
		/>
	),
	h2: ({ node: _node, className, ...props }) => (
		<h2
			className={cn("text-base font-semibold mt-3 mb-1.5 first:mt-0 text-foreground", className)}
			{...props}
		/>
	),
	h3: ({ node: _node, className, ...props }) => (
		<h3
			className={cn("text-sm font-semibold mt-2.5 mb-1 first:mt-0 text-foreground", className)}
			{...props}
		/>
	),
	h4: ({ node: _node, className, ...props }) => (
		<h4
			className={cn("text-sm font-medium mt-2 mb-1 first:mt-0 text-foreground", className)}
			{...props}
		/>
	),
	h5: ({ node: _node, className, ...props }) => (
		<h5
			className={cn("text-xs font-medium mt-1.5 mb-0.5 first:mt-0 text-foreground", className)}
			{...props}
		/>
	),
	h6: ({ node: _node, className, ...props }) => (
		<h6
			className={cn(
				"text-xs font-medium text-muted-foreground mt-1.5 mb-0.5 first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	p: ({ node: _node, className, ...props }) => (
		<p
			className={cn("text-sm leading-relaxed my-1.5 first:mt-0 last:mb-0", className)}
			{...props}
		/>
	),
	ul: ({ node: _node, className, ...props }) => {
		const isTaskList = className?.includes("contains-task-list");
		return (
			<ul
				className={cn(
					"my-1.5 space-y-0.5 text-sm",
					isTaskList ? "list-none pl-0" : "list-disc list-outside pl-5",
					className,
				)}
				{...props}
			/>
		);
	},
	ol: ({ node: _node, className, ...props }) => (
		<ol
			className={cn("list-decimal list-outside pl-5 my-1.5 space-y-0.5 text-sm", className)}
			{...props}
		/>
	),
	li: ({ node: _node, className, ...props }) => {
		const isTaskItem = className?.includes("task-list-item");
		return (
			<li
				className={cn(
					"text-sm leading-relaxed my-0.5",
					isTaskItem && "flex items-start gap-2 list-none",
					className,
				)}
				{...props}
			/>
		);
	},
	input: ({ node: _node, className, type, ...props }) => {
		if (type === "checkbox") {
			return (
				<input
					type="checkbox"
					className={cn(
						"size-3.5 mt-1 rounded border-border text-primary focus:ring-0",
						className,
					)}
					disabled
					{...props}
				/>
			);
		}
		return <input type={type} className={className} {...props} />;
	},
	blockquote: ({ node: _node, className, ...props }) => (
		<blockquote
			className={cn(
				"my-2 border-l-2 border-muted-foreground/40 pl-3 italic text-muted-foreground",
				className,
			)}
			{...props}
		/>
	),
	hr: ({ node: _node, className, ...props }) => (
		<hr className={cn("my-3 border-border", className)} {...props} />
	),
	a: ({ node: _node, href, children, className, ...props }) => {
		if (!isSafeUrl(href)) {
			return <span className={cn("text-muted-foreground", className)}>{children}</span>;
		}
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				className={cn(
					"text-primary underline underline-offset-4 hover:text-primary/80",
					className,
				)}
				{...props}
			>
				{children}
			</a>
		);
	},
	table: ({ node: _node, className, ...props }) => (
		<div className="my-2 w-full overflow-x-auto">
			<table
				className={cn("w-full border-collapse border border-border text-xs", className)}
				{...props}
			/>
		</div>
	),
	thead: ({ node: _node, className, ...props }) => (
		<thead className={cn("bg-muted/60", className)} {...props} />
	),
	tbody: ({ node: _node, ...props }) => <tbody {...props} />,
	tr: ({ node: _node, className, ...props }) => (
		<tr className={cn("border-b border-border even:bg-muted/30", className)} {...props} />
	),
	th: ({ node: _node, className, ...props }) => (
		<th
			className={cn(
				"border border-border px-2.5 py-1.5 text-left font-medium text-foreground",
				className,
			)}
			{...props}
		/>
	),
	td: ({ node: _node, className, ...props }) => (
		<td className={cn("border border-border px-2.5 py-1.5 text-left", className)} {...props} />
	),
	pre: ({ node: _node, className, ...props }) => (
		<pre
			className={cn(
				"my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit",
				className,
			)}
			{...props}
		/>
	),
	code: ({ node: _node, className, ...props }) => (
		<code
			className={cn(
				"rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground",
				className,
			)}
			{...props}
		/>
	),
	del: ({ node: _node, className, ...props }) => (
		<del className={cn("line-through text-muted-foreground", className)} {...props} />
	),
	strong: ({ node: _node, className, ...props }) => (
		<strong className={cn("font-semibold text-foreground", className)} {...props} />
	),
	em: ({ node: _node, className, ...props }) => (
		<em className={cn("italic", className)} {...props} />
	),
	img: ({ node: _node, src, alt, className, ...props }) => {
		if (!isSafeUrl(src)) return null;
		return (
			<img
				src={src}
				alt={alt}
				className={cn(
					"my-2 max-h-96 max-w-full rounded border border-border object-contain",
					className,
				)}
				loading="lazy"
				{...props}
			/>
		);
	},
};

export function MarkdownText({
	children,
	className,
}: {
	children?: string | null;
	className?: string;
}) {
	if (!children) return null;
	return (
		<div className={cn("text-sm text-foreground break-words", className)}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
				{children}
			</ReactMarkdown>
		</div>
	);
}
