// hooks/bin/usage-charts.ts — W152: the /usage client-side chart renderer.
// A plain JS string (no template literals inside — it is inlined verbatim
// into a page <script>) that reads the JSON payload the server embeds at
// #usage-data and renders the uPlot panels: stacked-area timeline by model
// group + hour-of-day bar histogram. uPlot 1.6.32 is vendored (MIT, license
// header on hooks/bin/vendor/) — no CDN, the LAN-only board must render
// offline. Dataviz discipline carried over from W127: recessive grid under
// marks, muted axis ink, fixed group order (color follows the entity),
// tabular-nums in the live legend.
export const USAGE_CHART_JS = `
(function () {
	"use strict";
	var DATA = document.getElementById("usage-data");
	if (!DATA || typeof uPlot !== "function") return;
	var P = JSON.parse(DATA.textContent);
	var GRID = "#2c2c2a";
	var HAIR = "#383835";
	var AXIS = "#898781";
	var fmtTok = function (n) {
		if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
		if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
		return String(Math.round(n));
	};
	var fmtVal = function (u, v) {
		return fmtTok(v == null ? 0 : v);
	};
	var mkAxis = function (side, values) {
		var a = {
			side: side,
			stroke: AXIS,
			grid: { show: true, stroke: GRID, width: 1 },
			ticks: { show: true, stroke: HAIR, width: 1 },
		};
		if (values) a.values = values;
		return a;
	};
	var yVals = function (u, splits) {
		return splits.map(function (v) {
			return fmtTok(v);
		});
	};
	var mount = function (el, opts, data) {
		var u = new uPlot(opts, data, el);
		var fit = function () {
			var w = el.clientWidth;
			if (w > 0 && w !== u.width) u.setSize({ width: w, height: opts.height });
		};
		if (typeof ResizeObserver === "function") {
			new ResizeObserver(fit).observe(el);
		} else {
			window.addEventListener("resize", fit);
		}
		return u;
	};
	// stacked-area timeline — series order IS the fixed group order, so a
	// group keeps its color everywhere it appears on the page
	var tEl = document.getElementById("u-timeline");
	if (tEl) {
		var series = [{}];
		for (var i = 0; i < P.groups.length; i++) {
			var c = P.slot[P.groups[i]];
			series.push({
				label: P.groups[i],
				stacked: true,
				stroke: c,
				fill: c,
				width: 1,
				points: { show: false },
				value: fmtVal,
			});
		}
		mount(
			tEl,
			{
				width: tEl.clientWidth,
				height: 300,
				legend: { show: true, live: true },
				scales: { x: { time: true } },
				series: series,
				axes: [mkAxis(2), mkAxis(3, yVals)],
			},
			P.timeline,
			tEl,
		);
	}
	// hour-of-day histogram — single-series distribution, slot 1 (flash blue)
	var hEl = document.getElementById("u-hours");
	if (hEl) {
		mount(
			hEl,
			{
				width: hEl.clientWidth,
				height: 190,
				legend: { show: false },
				scales: { x: { time: false } },
				series: [
					{},
					{
						label: "tokens",
						stroke: P.slot.flash,
						fill: P.slot.flash,
						paths: uPlot.paths.bars({ size: [0.72, 100] }),
						points: { show: false },
						value: fmtVal,
					},
				],
				axes: [
					mkAxis(2, function (u, splits) {
						return splits.map(function (v) {
							return String(Math.round(v)).padStart(2, "0");
						});
					}),
					mkAxis(3, yVals),
				],
			},
			P.byHour,
			hEl,
		);
	}
})();
`;
