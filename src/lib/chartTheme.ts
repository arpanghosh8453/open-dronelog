/** Canvas charts cannot inherit CSS colors. Keep their chrome aligned with theme.css. */
export const chartFontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const chartSeriesColors = [
  '#537bab', '#739b91', '#b18c50', '#8c84a6',
  '#a87482', '#68865c', '#b17c57', '#7b91ac',
];

export function getChartTheme(isLight: boolean) {
  return isLight
    ? { background: '#ffffff', border: '#d6dce3', text: '#222b36', label: '#536171', grid: '#e3e7ec' }
    : { background: '#28313b', border: '#3a434f', text: '#ecf0f4', label: '#aeb7c2', grid: '#353d47' };
}
