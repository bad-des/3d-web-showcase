/*
 * Page artwork for the 3D projects book (portfolio-book.ts).
 *
 * Every page is drawn onto a <canvas> and used as a texture, so the book uses
 * the site's own fonts and reads its content from the published project posts
 * (passed in from ProjectsBook.astro). A new post gets its own spread.
 *
 * Spread layout (spread 0 is the closed book):
 *   1            intro          | index
 *   2 .. N+1     project text   | the project's model "stage", or its photo
 *   N+2          request a quote | inside of the back cover
 *
 * Ported from shop.baddesigns.net's book (the same idea in that site's dark theme).
 */

import { CanvasTexture, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';

export const PAGE_W = 1; // world units, spine to fore-edge
export const PAGE_H = 1.32;

const PX_W = 1024;
const PX_H = Math.round((PX_W * PAGE_H) / PAGE_W);

// Slightly warmer than the page background so the book reads against the mat
const PAPER = '#f6f5f0';
const INK = '#111111';
const MUTED = '#6d6d68';
const RULE = '#d6d5cf';
const TAN = '#b9a16f';

/** One project, as ProjectsBook.astro serialises it */
export type BookProject = {
	number: string; // "SCAN_001"
	title: string;
	description: string;
	deliverable: string | null;
	fileName: string;
	group: string; // "Scan-to-CAD" or "Capture lab"
	url: string;
	image: string | null; // featured image, already resized
	imageAlt: string;
	model: string | null; // GLB floated over the right-hand page
	specs: { label: string; value: string }[];
};

type Fonts = { sans: string; mono: string; serif: string };

export type SpreadInfo = {
	/** Read out to screen readers when the spread changes */
	label: string;
	/** Index into the projects whose model floats over the right page */
	modelIndex: number | null;
	/** The project's write-up, for the "Read the write-up" button */
	url: string | null;
};

export type BookTextures = {
	/**
	 * Cover "metal/rough" map for PBR: green = roughness, blue = metalness
	 * (three.js reads those channels). Foil is metal and fairly smooth, the
	 * cloth around it is matte and not metal, so only the lettering glints.
	 */
	coverMetalRough: CanvasTexture;
	/** Paper fibre normal map, tiled across every page */
	paperNormal: CanvasTexture;
	/** sheetFronts[i] / sheetBacks[i]: sheet 0 is the front cover */
	sheetFronts: CanvasTexture[];
	sheetBacks: CanvasTexture[];
	backCoverInside: CanvasTexture;
	spreads: SpreadInfo[];
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/* ---------- fonts and images ---------- */

function cssFamily(variable: string, fallback: string) {
	const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
	return value || fallback;
}

async function loadFonts(): Promise<Fonts> {
	const fonts: Fonts = {
		sans: cssFamily('--font-heading', 'system-ui, sans-serif'),
		mono: cssFamily('--font-mono', 'ui-monospace, monospace'),
		serif: cssFamily('--font-serif', 'Georgia, serif'),
	};
	// Canvas text won't trigger a webfont download on its own; ask for each face
	// explicitly so the first draw isn't in the fallback font.
	await Promise.allSettled([
		document.fonts.load(`500 64px ${fonts.sans}`),
		document.fonts.load(`600 64px ${fonts.sans}`),
		document.fonts.load(`400 24px ${fonts.mono}`),
		document.fonts.load(`italic 400 64px ${fonts.serif}`),
	]);
	return fonts;
}

function loadImage(src: string | null): Promise<HTMLImageElement | null> {
	if (!src) return Promise.resolve(null);
	return new Promise((resolve) => {
		const img = new Image();
		img.decoding = 'async';
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null); // the page still draws, just without the photo
		img.src = src;
	});
}

/* ---------- drawing helpers ---------- */

function newPage(background = PAPER) {
	const canvas = document.createElement('canvas');
	canvas.width = PX_W;
	canvas.height = PX_H;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('2D canvas unavailable');
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, PX_W, PX_H);
	return { canvas, ctx };
}

/** Faint shading toward the spine so open pages look bound, not flat. */
function gutterShade(ctx: CanvasRenderingContext2D, side: 'left' | 'right') {
	const w = 120;
	const x0 = side === 'right' ? 0 : PX_W - w;
	const g = ctx.createLinearGradient(side === 'right' ? 0 : PX_W, 0, side === 'right' ? w : PX_W - w, 0);
	g.addColorStop(0, 'rgba(0,0,0,0.13)');
	g.addColorStop(1, 'rgba(0,0,0,0)');
	ctx.fillStyle = g;
	ctx.fillRect(x0, 0, w, PX_H);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(/\s+/)) {
		const next = line ? `${line} ${word}` : word;
		if (ctx.measureText(next).width > maxWidth && line) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) lines.push(line);
	return lines;
}

function paragraph(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines = 99) {
	let lines = wrap(ctx, text, maxWidth);
	if (lines.length > maxLines) {
		lines = lines.slice(0, maxLines);
		lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
	}
	lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
	return y + lines.length * lineHeight;
}

/** Mono label row with a rule under it, like the site's .section-label */
function fileLabel(ctx: CanvasRenderingContext2D, f: Fonts, left: string, right: string, y = 96) {
	ctx.font = `400 22px ${f.mono}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = INK;
	ctx.textAlign = 'left';
	ctx.fillText(left, 88, y);
	ctx.fillStyle = MUTED;
	ctx.textAlign = 'right';
	ctx.fillText(right, PX_W - 88, y);
	ctx.textAlign = 'left';
	ctx.fillStyle = RULE;
	ctx.fillRect(88, y + 18, PX_W - 176, 2);
}

function folio(ctx: CanvasRenderingContext2D, f: Fonts, n: number, side: 'left' | 'right') {
	ctx.font = `400 20px ${f.mono}`;
	ctx.fillStyle = MUTED;
	ctx.textAlign = side === 'left' ? 'left' : 'right';
	ctx.fillText(`p.${pad2(n)}`, side === 'left' ? 88 : PX_W - 88, PX_H - 72);
	ctx.textAlign = 'left';
}

/** Two-line headline in the sans, like the site's headings */
function headline(ctx: CanvasRenderingContext2D, f: Fonts, first: string, second: string, x: number, y: number, size: number) {
	ctx.fillStyle = INK;
	ctx.font = `500 ${size}px ${f.sans}`;
	ctx.letterSpacing = `${(-size * 0.045).toFixed(1)}px`; // the site's h1 tracking
	ctx.fillText(first, x, y);
	ctx.fillText(second, x, y + size * 0.92);
	ctx.letterSpacing = '0px';
}

/** A photo "print" with a white border and a faint shadow, cropped to fill the box */
function photo(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
	ctx.save();
	ctx.shadowColor = 'rgba(0,0,0,0.18)';
	ctx.shadowBlur = 24;
	ctx.shadowOffsetY = 8;
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(x - 14, y - 14, w + 28, h + 28);
	ctx.restore();
	const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
	const sw = w / scale;
	const sh = h / scale;
	const sx = (img.naturalWidth - sw) / 2;
	const sy = (img.naturalHeight - sh) / 2;
	ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/* ---------- individual pages ---------- */

function drawCover(f: Fonts) {
	const { canvas, ctx } = newPage('#121212');
	// The metal/roughness mask, drawn in step with the artwork below
	const { canvas: mask, ctx: m } = newPage('rgb(0,200,0)'); // cloth: roughness ~0.78, metalness 0
	const FOIL = 'rgb(0,72,255)'; // foil: roughness ~0.28, metalness 1
	// Cloth grain (seeded, so it's the same every visit)
	let seed = 11;
	const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	for (let i = 0; i < 9000; i++) {
		ctx.fillStyle = `rgba(255,255,255,${rand() * 0.05})`;
		ctx.fillRect(rand() * PX_W, rand() * PX_H, 1.5, 1.5);
	}
	ctx.strokeStyle = 'rgba(185,161,111,0.75)';
	ctx.lineWidth = 3;
	ctx.strokeRect(56, 56, PX_W - 112, PX_H - 112);
	m.strokeStyle = FOIL;
	m.lineWidth = 3;
	m.strokeRect(56, 56, PX_W - 112, PX_H - 112);

	// Tan foil wordmark
	const foil = ctx.createLinearGradient(0, 560, PX_W, 760);
	foil.addColorStop(0, '#8f7c55');
	foil.addColorStop(0.45, '#d9c697');
	foil.addColorStop(0.55, '#efe2bf');
	foil.addColorStop(1, '#9d8760');
	for (const [c, style] of [
		[ctx, foil],
		[m, FOIL],
	] as const) {
		c.fillStyle = style;
		c.textAlign = 'center';
		c.font = `600 132px ${f.sans}`;
		c.fillText('Bad', PX_W / 2, 640);
		c.font = `italic 400 150px ${f.serif}`;
		c.fillText('Designs', PX_W / 2, 770);
	}
	ctx.font = `400 24px ${f.mono}`;
	ctx.fillStyle = 'rgba(237,237,234,0.55)';
	ctx.fillText('PROJECTS  ·  SCAN-TO-CAD', PX_W / 2, PX_H - 130);
	ctx.textAlign = 'left';
	return { canvas, mask };
}

/**
 * Paper fibre normal map. A height field of fine fibres and speckle is drawn
 * first, then turned into normals (the slope in x and y, packed into RGB),
 * which is what a normal map stores. Under a low lamp the page surface then
 * catches light with a slight tooth instead of looking like flat plastic.
 */
function drawPaperNormal() {
	const S = 512;
	const { canvas: height, ctx } = newPage('#808080');
	height.width = height.height = S;
	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, S, S);
	let seed = 5;
	const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	for (let i = 0; i < 2600; i++) {
		const x = rand() * S;
		const y = rand() * S;
		const a = rand() * Math.PI;
		const len = 4 + rand() * 18;
		ctx.strokeStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.08 + rand() * 0.12})`;
		ctx.lineWidth = 0.6 + rand();
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
		ctx.stroke();
	}
	const src = ctx.getImageData(0, 0, S, S).data;
	const out = ctx.createImageData(S, S);
	const h = (x: number, y: number) => src[(((y + S) % S) * S + ((x + S) % S)) * 4] / 255;
	const strength = 2.2;
	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			// Slope from neighbouring heights (wrapping, so the map tiles)
			const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
			const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
			const len = Math.hypot(dx, dy, 1);
			const i = (y * S + x) * 4;
			out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
			out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
			out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
			out.data[i + 3] = 255;
		}
	}
	ctx.putImageData(out, 0, 0);
	const t = new CanvasTexture(height);
	t.colorSpace = NoColorSpace; // data, not colour
	t.wrapS = t.wrapT = RepeatWrapping;
	t.repeat.set(2, 2.6);
	return t;
}

function drawIntro(f: Fonts, count: number) {
	const { canvas, ctx } = newPage();
	fileLabel(ctx, f, 'Projects/', `${count} files`);
	headline(ctx, f, 'The', 'work.', 88, 360, 150);
	ctx.font = `400 34px ${f.sans}`;
	ctx.fillStyle = '#3a3a37';
	paragraph(
		ctx,
		'Each project starts with a physical part and ends with a 3D file. Click the right-hand page to turn forward, the left to turn back.',
		88,
		640,
		PX_W - 260,
		48,
	);
	ctx.fillStyle = TAN;
	ctx.fillRect(88, PX_H - 220, 64, 8);
	folio(ctx, f, 1, 'left');
	gutterShade(ctx, 'left');
	return canvas;
}

function drawIndex(f: Fonts, projects: BookProject[]) {
	const { canvas, ctx } = newPage();
	fileLabel(ctx, f, 'Index/', 'Contents');
	let y = 250;
	projects.forEach((p, i) => {
		ctx.font = `400 22px ${f.mono}`;
		ctx.fillStyle = MUTED;
		ctx.fillText(`${p.number} · ${p.group}`, 88, y);
		ctx.font = `500 42px ${f.sans}`;
		ctx.fillStyle = INK;
		const title = wrap(ctx, p.title, PX_W - 300)[0];
		ctx.fillText(title === p.title ? title : `${title}…`, 88, y + 56);
		ctx.font = `400 22px ${f.mono}`;
		ctx.fillStyle = MUTED;
		ctx.textAlign = 'right';
		ctx.fillText(`p.${pad2(i * 2 + 3)}`, PX_W - 88, y + 52);
		ctx.textAlign = 'left';
		ctx.fillStyle = RULE;
		ctx.fillRect(88, y + 90, PX_W - 176, 2);
		y += 150;
	});
	folio(ctx, f, 2, 'right');
	gutterShade(ctx, 'right');
	return canvas;
}

function drawProjectText(f: Fonts, p: BookProject, index: number, page: number, img: HTMLImageElement | null) {
	const { canvas, ctx } = newPage();
	fileLabel(ctx, f, p.number, p.fileName);
	ctx.font = `400 260px ${f.sans}`;
	ctx.fillStyle = '#e6e5df';
	ctx.fillText(pad2(index + 1), 70, 400);
	ctx.font = `400 22px ${f.mono}`;
	ctx.fillStyle = MUTED;
	ctx.fillText(p.group.toUpperCase(), 88, 470);
	ctx.font = `500 72px ${f.sans}`;
	ctx.fillStyle = INK;
	let y = paragraph(ctx, p.title, 88, 560, PX_W - 176, 76, 3);
	ctx.font = `400 30px ${f.sans}`;
	ctx.fillStyle = '#3a3a37';
	y = paragraph(ctx, p.description, 88, y + 30, PX_W - 220, 43, 5);
	if (p.deliverable) {
		ctx.font = `400 22px ${f.mono}`;
		ctx.fillStyle = INK;
		paragraph(ctx, p.deliverable, 88, y + 44, PX_W - 220, 32, 2);
	}
	// When a model takes the right page, the photo goes small on this one
	if (p.model && img) photo(ctx, img, PX_W - 88 - 300, PX_H - 140 - 220, 300, 220);
	folio(ctx, f, page, 'left');
	gutterShade(ctx, 'left');
	return canvas;
}

/** Right-hand page under a floating model: a scan bed with registration marks */
function drawStage(f: Fonts, p: BookProject, index: number, page: number) {
	const { canvas, ctx } = newPage();
	const cx = PX_W / 2;
	const cy = PX_H / 2 - 20;
	ctx.fillStyle = '#d3d2cb';
	for (let x = 88; x <= PX_W - 88; x += 32) {
		for (let y = 160; y <= PX_H - 160; y += 32) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
	}
	ctx.strokeStyle = INK;
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(cx, cy, 250, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([6, 10]);
	ctx.beginPath();
	ctx.arc(cx, cy, 330, 0, Math.PI * 2);
	ctx.stroke();
	ctx.setLineDash([]);
	for (const [dx, dy] of [
		[0, -1],
		[0, 1],
		[-1, 0],
		[1, 0],
	]) {
		ctx.beginPath();
		ctx.moveTo(cx + dx * 220, cy + dy * 220);
		ctx.lineTo(cx + dx * 370, cy + dy * 370);
		ctx.stroke();
	}
	for (const [x, y] of [
		[140, 200],
		[PX_W - 140, 200],
		[140, PX_H - 200],
		[PX_W - 140, PX_H - 200],
	]) {
		ctx.fillStyle = INK;
		ctx.beginPath();
		ctx.arc(x, y, 22, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = PAPER;
		ctx.beginPath();
		ctx.arc(x, y, 8, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.font = `400 22px ${f.mono}`;
	ctx.fillStyle = MUTED;
	ctx.fillText(`fig. ${pad2(index + 1)} — ${p.fileName}`, 88, 110);
	folio(ctx, f, page, 'right');
	gutterShade(ctx, 'right');
	return canvas;
}

/** Right-hand page for a project with no model: its photo, full width */
function drawPhotoPage(f: Fonts, p: BookProject, index: number, page: number, img: HTMLImageElement | null) {
	const { canvas, ctx } = newPage();
	ctx.font = `400 22px ${f.mono}`;
	ctx.fillStyle = MUTED;
	ctx.fillText(`fig. ${pad2(index + 1)}`, 88, 110);
	if (img) {
		photo(ctx, img, 110, 220, PX_W - 220, 760);
		ctx.font = `400 26px ${f.sans}`;
		ctx.fillStyle = '#3a3a37';
		paragraph(ctx, p.imageAlt, 110, 1060, PX_W - 220, 36, 3);
	}
	folio(ctx, f, page, 'right');
	gutterShade(ctx, 'right');
	return canvas;
}

function drawQuote(f: Fonts, page: number) {
	const { canvas, ctx } = newPage();
	fileLabel(ctx, f, 'Next/', 'Your part');
	headline(ctx, f, 'Have a part', 'like these?', 88, 360, 112);
	ctx.font = `400 34px ${f.sans}`;
	ctx.fillStyle = '#3a3a37';
	paragraph(ctx, 'Send photos and a short description for a fixed quote. You get back a file you can print, machine or change.', 88, 600, PX_W - 240, 48);
	// Button drawn on the page; the real link sits in the controls under the book
	ctx.fillStyle = TAN;
	ctx.beginPath();
	ctx.roundRect(88, 900, 380, 84, 42);
	ctx.fill();
	ctx.fillStyle = INK;
	ctx.font = `500 26px ${f.mono}`;
	ctx.fillText('Request a quote →', 128, 952);
	folio(ctx, f, page, 'left');
	gutterShade(ctx, 'left');
	return canvas;
}

function drawBackInside(f: Fonts) {
	const { canvas, ctx } = newPage('#1a1a1a');
	ctx.textAlign = 'center';
	ctx.font = `600 64px ${f.sans}`;
	ctx.fillStyle = '#d9c697';
	ctx.fillText('Bad', PX_W / 2, PX_H / 2 - 20);
	ctx.font = `italic 400 72px ${f.serif}`;
	ctx.fillText('Designs', PX_W / 2, PX_H / 2 + 50);
	ctx.font = `400 22px ${f.mono}`;
	ctx.fillStyle = 'rgba(237,237,234,0.6)';
	ctx.fillText('Raleigh, NC', PX_W / 2, PX_H / 2 + 150);
	ctx.fillText('baddesigns.net', PX_W / 2, PX_H / 2 + 186);
	ctx.textAlign = 'left';
	return canvas;
}

/* ---------- assembly ---------- */

function toTexture(canvas: HTMLCanvasElement, mirror = false) {
	const t = new CanvasTexture(canvas);
	t.colorSpace = SRGBColorSpace;
	t.anisotropy = 8;
	if (mirror) {
		// A turned page is seen from its back face, which samples U backwards
		t.wrapS = RepeatWrapping;
		t.repeat.x = -1;
		t.offset.x = 1;
	}
	return t;
}

export async function buildBookTextures(projects: BookProject[]): Promise<BookTextures> {
	const [f, images] = await Promise.all([loadFonts(), Promise.all(projects.map((p) => loadImage(p.image)))]);

	const lefts: HTMLCanvasElement[] = [drawIntro(f, projects.length)];
	const rights: HTMLCanvasElement[] = [drawIndex(f, projects)];
	const spreads: SpreadInfo[] = [
		{ label: 'Closed book', modelIndex: null, url: null },
		{ label: 'Introduction and index', modelIndex: null, url: null },
	];
	projects.forEach((p, i) => {
		lefts.push(drawProjectText(f, p, i, i * 2 + 3, images[i]));
		rights.push(p.model ? drawStage(f, p, i, i * 2 + 4) : drawPhotoPage(f, p, i, i * 2 + 4, images[i]));
		spreads.push({ label: `${p.number}: ${p.title}`, modelIndex: p.model ? i : null, url: p.url });
	});
	lefts.push(drawQuote(f, projects.length * 2 + 3));
	spreads.push({ label: 'Request a quote', modelIndex: null, url: null });

	// Sheet i's front is the right page of spread i (sheet 0 = cover), its back
	// is the left page of spread i + 1. The last spread's right page is the
	// inside of the back cover.
	const cover = drawCover(f);
	const coverMetalRough = new CanvasTexture(cover.mask);
	coverMetalRough.colorSpace = NoColorSpace; // data, not colour
	coverMetalRough.anisotropy = 8;
	const sheetFronts: CanvasTexture[] = [toTexture(cover.canvas)];
	const sheetBacks: CanvasTexture[] = [];
	for (let i = 0; i < lefts.length; i++) {
		if (i > 0) sheetFronts.push(toTexture(rights[i - 1]));
		sheetBacks.push(toTexture(lefts[i], true));
	}

	return {
		sheetFronts,
		sheetBacks,
		backCoverInside: toTexture(drawBackInside(f)),
		coverMetalRough,
		paperNormal: drawPaperNormal(),
		spreads,
	};
}
