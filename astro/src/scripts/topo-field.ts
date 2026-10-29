/*
 * Topographic contour lines over a faint cutting-mat grid, drawn behind the
 * footer band. Why it's here: contours are what a 3D scanner's height data
 * looks like, and the grid repeats the cutting mat the projects book sits
 * on, so the band carries the same workshop motif as the book.
 *
 * Adapted from ThreeUI's "Topo Field" (https://github.com/MengTo/threeui,
 * MIT, (c) 2026 Meng To): same banded-noise idea, recoloured to the site
 * palette, made transparent so the band's own colour shows through, and
 * throttled. The 2D simplex noise is Ian McEwan / Ashima Arts'
 * (https://github.com/ashima/webgl-noise, MIT).
 *
 * Plain WebGL on one full-screen triangle: no three.js, nothing to download.
 * Moves only for a few seconds after scrolling into view, at 30 fps and a
 * lower pixel ratio on phones; a single still frame when the visitor prefers
 * reduced motion. Colours come from the --topo-line and --topo-grid tokens.
 */

const VERTEX = /* glsl */ `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAGMENT = /* glsl */ `
precision mediump float;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDpr;
uniform vec3 uLine;   // contour colour
uniform vec3 uGrid;   // grid colour

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
	const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
	vec2 i = floor(v + dot(v, C.yy));
	vec2 x0 = v - i + dot(i, C.xx);
	vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
	vec4 x12 = x0.xyxy + C.xxzz;
	x12.xy -= i1;
	i = mod(i, 289.0);
	vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
	vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
	m = m * m;
	m = m * m;
	vec3 x = 2.0 * fract(p * C.www) - 1.0;
	vec3 h = abs(x) - 0.5;
	vec3 ox = floor(x + 0.5);
	vec3 a0 = x - ox;
	m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
	vec3 g;
	g.x = a0.x * x0.x + h.x * x0.y;
	g.yz = a0.yz * x12.xz + h.yz * x12.yw;
	return 130.0 * dot(m, g);
}

void main() {
	// Square-ish noise space whatever the band's shape (scaled by height)
	vec2 st = gl_FragCoord.xy / uResolution.y;

	// 1. Grid: 1 physical pixel lines every 48 CSS pixels, like the mat in the book
	float cell = 48.0 * uDpr;
	vec2 g = fract(gl_FragCoord.xy / cell);
	float edge = 1.0 - 1.0 / cell;
	float grid = clamp(step(edge, g.x) + step(edge, g.y), 0.0, 1.0);

	// 2. Contours: noise read as a height map, cut into bands; the line is where
	//    a band starts. fwidth() keeps lines ~1px wide at any pixel ratio.
	float n = snoise(st * 1.1 + vec2(uTime * 0.012, uTime * 0.02)) * 0.5 + 0.5;
	float bands = n * 9.0;
	float d = abs(fract(bands) - 0.5) * 2.0;           // 0 on a contour, 1 between
	float w = fwidth(bands) * 2.0;
	float line = 1.0 - smoothstep(0.0, w * 1.2, d);
	// Every fifth contour is an index line, a little stronger (as on survey maps)
	float index = 1.0 - step(0.5, mod(floor(bands + 0.5), 5.0));
	// Capped so every text colour on the band keeps WCAG AA even where it
	// crosses an index line and a grid line at once (checked: error text 4.5:1)
	float lineA = line * mix(0.08, 0.12, index);

	// Fade toward the bottom so the giant word stays clean
	float fade = smoothstep(0.0, 0.45, gl_FragCoord.y / uResolution.y);

	vec3 color = uGrid * grid * 0.03 + uLine * lineA;
	float alpha = max(grid * 0.03, lineA) * fade;
	gl_FragColor = vec4(color * fade, alpha); // premultiplied
}
`;

function cssColor(el: Element, name: string, fallback: [number, number, number]): [number, number, number] {
	const value = getComputedStyle(el).getPropertyValue(name).trim();
	const m = /^#([0-9a-f]{6})$/i.exec(value);
	if (!m) return fallback;
	const n = parseInt(m[1], 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function mountTopoField(canvas: HTMLCanvasElement) {
	const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'low-power' });
	if (!gl || !gl.getExtension('OES_standard_derivatives')) {
		canvas.remove(); // the band looks complete without it
		return;
	}

	const compile = (type: number, source: string) => {
		const s = gl.createShader(type)!;
		gl.shaderSource(s, type === gl.FRAGMENT_SHADER ? `#extension GL_OES_standard_derivatives : enable\n${source}` : source);
		gl.compileShader(s);
		return s;
	};
	const program = gl.createProgram()!;
	gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		canvas.remove();
		return;
	}
	gl.useProgram(program);

	// One triangle that covers the whole canvas
	gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const aPos = gl.getAttribLocation(program, 'aPos');
	gl.enableVertexAttribArray(aPos);
	gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

	const uResolution = gl.getUniformLocation(program, 'uResolution');
	const uTime = gl.getUniformLocation(program, 'uTime');
	const uDpr = gl.getUniformLocation(program, 'uDpr');
	gl.uniform3fv(gl.getUniformLocation(program, 'uLine'), cssColor(canvas, '--topo-line', [0.725, 0.631, 0.435]));
	gl.uniform3fv(gl.getUniformLocation(program, 'uGrid'), cssColor(canvas, '--topo-grid', [0.93, 0.9, 0.85]));

	const small = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
	let dpr = 1;
	const resize = () => {
		dpr = Math.min(window.devicePixelRatio || 1, small ? 1 : 1.5);
		const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		if (canvas.width === w && canvas.height === h) return;
		canvas.width = w;
		canvas.height = h;
		gl.viewport(0, 0, w, h);
		gl.uniform2f(uResolution, w, h);
		gl.uniform1f(uDpr, dpr);
		draw(lastTime);
	};

	// A random start, so the contours differ from visit to visit
	const offset = Math.random() * 500;
	let lastTime = offset;
	const draw = (t: number) => {
		lastTime = t;
		gl.uniform1f(uTime, t);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	};

	// Each time the band scrolls into view the contours shift once, easing out
	// over DRIFT_MS, then hold still. Under 5 seconds, so no pause control is
	// needed (WCAG 2.2.2), and the GPU is idle the rest of the time.
	const DRIFT_MS = 4500;
	const DRIFT = 4; // shader time units per drift
	let raf = 0;
	let visible = false;
	let lastFrame = 0;
	let driftFrom = offset;
	let driftStart = 0;
	const loop = (now: number) => {
		const k = Math.min((now - driftStart) / DRIFT_MS, 1);
		raf = k < 1 ? requestAnimationFrame(loop) : 0;
		if (k < 1 && now - lastFrame < 1000 / 30) return;
		lastFrame = now;
		draw(driftFrom + DRIFT * (1 - Math.pow(1 - k, 3)));
	};
	const update = () => {
		cancelAnimationFrame(raf);
		raf = 0;
		if (visible && !reduced.matches) {
			driftFrom = lastTime;
			driftStart = performance.now();
			raf = requestAnimationFrame(loop);
		} else {
			draw(lastTime); // frozen: one still frame
		}
	};

	new ResizeObserver(resize).observe(canvas);
	resize();
	new IntersectionObserver(([entry]) => {
		visible = entry.isIntersecting;
		update();
	}).observe(canvas);
	reduced.addEventListener('change', update);
}
