export const MAX_RENDERED_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_RENDERED_PAGE_DATA_BYTES = 12 * 1024 * 1024;

export function formatMegabytes(bytes: number): string {
	return `${bytes / (1024 * 1024)} MB`;
}

export function renderedPageCaptureCode(): string {
	return `() => {
		const html = document.documentElement.outerHTML;
		const bytes = new TextEncoder().encode(html).byteLength;
		if (bytes > ${MAX_RENDERED_HTML_BYTES}) {
			throw new Error('Rendered page HTML exceeds the ${formatMegabytes(MAX_RENDERED_HTML_BYTES)} extraction limit');
		}
		return { html, url: location.href, title: document.title };
	}`;
}
