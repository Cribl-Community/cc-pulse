// Stands in for @capra/theme/visualizations in scripts/test-heartbeat.mjs: records every getChartTheme call.
export const calls = (globalThis.__chartCalls ??= []);
export function getChartTheme(options) {
  calls.push(options);
  return { mode: options.mode, paletteName: options.palette, palette: options.mode === 'dark' ? ['#dark01', '#dark02'] : ['#light1', '#light2'] };
}
