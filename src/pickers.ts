/** 格式化 ISO 时间 → MM-DD HH:mm */
export function formatTime(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso.slice(5, 16);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
