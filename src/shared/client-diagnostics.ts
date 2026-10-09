// TEMP #89 diagnostics — remove after root cause found
// 前端「添加附件」文件选择框没弹出时的诊断上报契约（前后端共用）。
// 隐私：只收控件状态、窗口尺寸、浏览器版本等；不收文件名 / 文件内容 / 任务标题 / 任务 id。
import { z } from "zod";

/** 请求体上限（字节）。 */
export const CLIENT_DIAG_MAX_BYTES = 4096;

const shortText = (max: number) => z.string().max(max);
const finite = z.number().finite();

export const clientDiagnosticSchema = z
	.object({
		/** picker_no_open：点了 label，2 秒内没有 change / cancel / blur / hidden。
		 *  picker_click_intercepted：点击坐标落在按钮矩形里，但事件目标不在 label 内（疑似被遮罩吃掉）。 */
		event: z.enum(["picker_no_open", "picker_click_intercepted"]),
		inputClicked: z.boolean(),
		labelDefaultPrevented: z.boolean(),
		inputDisabled: z.boolean(),
		labelAriaDisabled: z.boolean(),
		/** label 当前带禁用态 class（pointer-events-none / cursor-not-allowed / *disabled*，不含 `disabled:` 变体）。 */
		labelClassDisabled: z.boolean(),
		/** label 计算后的 pointer-events。 */
		labelPointerEvents: shortText(32),
		inputConnected: z.boolean(),
		inputDisplay: shortText(32),
		inputVisibility: shortText(32),
		pickerRect: z.object({ x: finite, y: finite, width: finite, height: finite }).strict(),
		click: z.object({ x: finite, y: finite }).strict(),
		/** detail === 0：键盘（空格 / 回车）或脚本触发，不是鼠标点击。 */
		keyboardActivation: z.boolean(),
		/** 点击坐标处的元素：tag + data-testid 或前几个 class（截断）。 */
		elementAtPoint: shortText(120).nullable(),
		elementAtPointInsidePicker: z.boolean(),
		docHasFocus: z.boolean(),
		/** navigator.userActivation.isActive（点击当下）；不支持为 null。 */
		userActivationActive: z.boolean().nullable(),
		inIframe: z.boolean(),
		displayModeStandalone: z.boolean(),
		isTauri: z.boolean(),
		innerWidth: finite,
		innerHeight: finite,
		devicePixelRatio: finite,
		userAgent: shortText(512),
		uaBrands: z
			.array(z.object({ brand: shortText(64), version: shortText(32) }).strict())
			.max(10)
			.nullable(),
		uaPlatform: shortText(32).nullable(),
		uaMobile: z.boolean().nullable(),
		isTempTask: z.boolean(),
		buildCommit: shortText(64).nullable(),
		/** 从点击到上报的毫秒数。 */
		elapsedMs: finite,
	})
	.strict();

export type ClientDiagnostic = z.infer<typeof clientDiagnosticSchema>;

/** CLIENT_DIAG_USER_IDS：逗号分隔的 user id；空 / 未设置 = 关闭（全部丢弃）。 */
export function parseDiagUserIds(raw: string | undefined | null): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
}
