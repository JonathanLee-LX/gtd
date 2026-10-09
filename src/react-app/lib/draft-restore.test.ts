import { describe, expect, it } from "vitest";
import { createFailedMessage, restoreFailedDraft } from "./draft-restore";

describe("restoreFailedDraft (composer + mobile quick collect)", () => {
	it("puts the failed text back into an empty input", () => {
		expect(restoreFailedDraft("", "买牛奶")).toBe("买牛奶");
		expect(restoreFailedDraft("   ", "买牛奶")).toBe("买牛奶");
	});

	it("never overwrites what the user already typed next", () => {
		expect(restoreFailedDraft("下一条", "买牛奶")).toBe("下一条");
	});
});

describe("createFailedMessage", () => {
	it("names the lost item and the reason", () => {
		expect(createFailedMessage("买牛奶", new Error("服务器出错了"))).toBe("「买牛奶」没有添加成功：服务器出错了");
		expect(createFailedMessage("买牛奶", null, "没有加入收件箱")).toBe("「买牛奶」没有加入收件箱：请重试");
	});
});
