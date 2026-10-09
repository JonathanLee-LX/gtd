import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RefreshCwIcon } from "lucide-react";
import { loadErrorMessage } from "../lib/session";

/**
 * #101：列表加载失败（断网 / 5xx，且没有缓存数据）时原地提示 + 重试按钮，不留白页。
 * 401 不会走到这里 —— Shell 统一跳登录页。
 */
export function LoadErrorRetry({ error, onRetry }: { error: unknown; onRetry?: () => Promise<unknown> }) {
	const [retrying, setRetrying] = useState(false);
	return (
		<div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 p-4" role="alert">
			<p className="text-sm text-destructive">{loadErrorMessage(error)}</p>
			{onRetry ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={retrying}
					onClick={() => {
						setRetrying(true);
						void onRetry().finally(() => setRetrying(false));
					}}
				>
					{retrying ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
					重试
				</Button>
			) : null}
		</div>
	);
}
