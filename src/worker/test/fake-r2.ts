/** 内存版 R2 替身：只实现附件服务用到的 put / get / head / delete。 */
export class FakeR2 {
	objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
	failDelete = false;
	deleted: string[] = [];

	async put(
		key: string,
		value: Uint8Array,
		options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } },
	) {
		if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
		this.objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
		return this.meta(key);
	}

	async head(key: string) {
		return this.objects.has(key) ? this.meta(key) : null;
	}

	async get(key: string) {
		const object = this.objects.get(key);
		if (!object) return null;
		return { ...this.meta(key), body: streamOf(object.bytes) };
	}

	async delete(keys: string | string[]) {
		if (this.failDelete) throw new Error("r2 down");
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			this.deleted.push(key);
			this.objects.delete(key);
		}
	}

	private meta(key: string) {
		const object = this.objects.get(key)!;
		return {
			key,
			size: object.bytes.byteLength,
			etag: `etag-${key}`,
			httpEtag: `"etag-${key}"`,
			httpMetadata: { contentType: object.contentType },
		};
	}
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake pdf body\n");
