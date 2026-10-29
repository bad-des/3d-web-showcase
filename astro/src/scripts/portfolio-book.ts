/*
 * The 3D projects book on /projects/: a closed book on a cutting mat under a
 * brass desk lamp, in a dark room. Click it to open; click the right page to turn forward, the left
 * to turn back (or use the buttons, arrow keys and Esc). Each project with a
 * model has it floating over the right-hand page once the page has landed.
 *
 * Plain three.js (no framework), loaded by ProjectsBook.astro only when the
 * book scrolls near the viewport. Page artwork comes from book-pages.ts; the
 * room, lighting, materials, shaders and post-processing from book-scene.ts.
 * Ported from shop.baddesigns.net's React Three Fiber version.
 *
 * How a page turns: each sheet is a strip of SEGMENTS quads hinged at the
 * spine (x = 0). Turning it rotates the strip from 0 to PI around the spine
 * while the outer segments lag behind, which bends the paper into a curl.
 */

import {
	AgXToneMapping,
	BackSide,
	Box3,
	BoxGeometry,
	BufferAttribute,
	BufferGeometry,
	MathUtils,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PCFShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	Raycaster,
	Vector2,
	Vector3,
	WebGLRenderer,
	Group,
	type Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { PAGE_H, PAGE_W, buildBookTextures, type BookProject, type BookTextures } from './book-pages';
import { createBookStage, makeContactShadow, type Quality } from './book-scene';

const SEGMENTS = 28;
const FLIP_SECONDS = 1.05;
const STAGGER_SECONDS = 0.09; // between sheets when jumping several spreads
const SHEET_GAP = 0.0035; // vertical spacing between stacked sheets
const BOARD = 0.022; // cover board thickness
const BLOCK = 0.03; // full paper block thickness
const DRACO_DECODERS = '/vendor/draco/'; // self-hosted, same as the 3D viewers in posts
const AMBIENT_MS = 5000; // ambient motion after the last interaction (WCAG 2.2.2: under 5 s)
const SETTLE_MS = 1500; // then this long for eased camera and page motion to finish

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/* ---------- one turning sheet ---------- */

type Sheet = {
	geometry: BufferGeometry;
	p: number;
	from: number;
	to: number;
	start: number;
	duration: number;
	lift: number;
	lastP: number;
	lastBase: number;
};

function makeSheetGeometry() {
	const g = new BufferGeometry();
	const verts = (SEGMENTS + 1) * 2;
	const uv = new Float32Array(verts * 2);
	const index: number[] = [];
	for (let i = 0; i <= SEGMENTS; i++) {
		for (let j = 0; j < 2; j++) {
			const k = i * 2 + j;
			uv[k * 2] = i / SEGMENTS;
			uv[k * 2 + 1] = j; // v = 1 is the top edge (z = -H/2, away from the camera)
		}
		if (i < SEGMENTS) {
			const a = i * 2;
			const b = (i + 1) * 2;
			index.push(a, b, a + 1, b, b + 1, a + 1); // +Y normal on the front face
		}
	}
	g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
	g.setAttribute('uv', new BufferAttribute(uv, 2));
	g.setIndex(index);
	return g;
}

/** Writes the curled strip into the geometry for turn progress p (0 = right, 1 = left). */
function bendSheet(g: BufferGeometry, p: number, direction: number, baseY: number) {
	const pos = g.getAttribute('position') as BufferAttribute;
	const seg = PAGE_W / SEGMENTS;
	const theta = p * Math.PI;
	const curl = Math.sin(p * Math.PI) * 1.15 * direction; // strongest mid-turn
	let x = 0;
	let y = baseY;
	for (let i = 0; i <= SEGMENTS; i++) {
		pos.setXYZ(i * 2, x, y, PAGE_H / 2);
		pos.setXYZ(i * 2 + 1, x, y, -PAGE_H / 2);
		const t = (i + 0.5) / SEGMENTS;
		const a = MathUtils.clamp(theta - curl * t * t, 0, Math.PI);
		x += Math.cos(a) * seg;
		y += Math.sin(a) * seg;
	}
	pos.needsUpdate = true;
	g.computeVertexNormals();
	g.computeBoundingSphere();
}

/* ---------- models ---------- */

let gltfLoader: GLTFLoader | undefined;
function loader() {
	if (!gltfLoader) {
		const draco = new DRACOLoader();
		draco.setDecoderPath(DRACO_DECODERS);
		gltfLoader = new GLTFLoader();
		gltfLoader.setDRACOLoader(draco);
	}
	return gltfLoader;
}

/** Centre the model and scale it to float over a page */
function prepareModel(scene: Object3D) {
	const wrapper = new Group();
	wrapper.add(scene);
	wrapper.updateMatrixWorld(true);
	const box = new Box3().setFromObject(wrapper);
	const size = box.getSize(new Vector3());
	const center = box.getCenter(new Vector3());
	scene.position.sub(center);
	wrapper.scale.setScalar(0.55 / Math.max(size.x, size.y, size.z, 1e-6));
	wrapper.traverse((o) => {
		if ((o as Mesh).isMesh) o.castShadow = true;
	});
	return wrapper;
}

type Floating = { outer: Group; spin: Group; amount: number; state: 'idle' | 'loading' | 'ready' | 'failed' };

/* ---------- the book ---------- */

export function mountBook(root: HTMLElement, projects: BookProject[]) {
	const stage = root.querySelector<HTMLElement>('[data-book-stage]');
	const statusEl = root.querySelector<HTMLElement>('[data-book-status]');
	const labelEl = root.querySelector<HTMLElement>('[data-book-label]');
	const openBtn = root.querySelector<HTMLButtonElement>('[data-book-open]');
	const backBtn = root.querySelector<HTMLButtonElement>('[data-book-back]');
	const nextBtn = root.querySelector<HTMLButtonElement>('[data-book-next]');
	const closeBtn = root.querySelector<HTMLButtonElement>('[data-book-close]');
	const readLink = root.querySelector<HTMLAnchorElement>('[data-book-read]');
	const quoteLink = root.querySelector<HTMLAnchorElement>('[data-book-quote]');
	if (!stage) return;

	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ antialias: true });
	} catch {
		// No WebGL: leave the project grid below to do the job
		root.hidden = true;
		return;
	}
	// Phones and small screens get the lighter set-up (see book-scene.ts)
	const quality: Quality = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches ? 'low' : 'high';
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.5));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = PCFShadowMap; // soft edges come from each light's shadow.radius
	// AgX: a filmic curve that rolls bright highlights off gently and keeps the
	// lamp's warm hue, instead of clipping or drifting yellow. Applied by the
	// OutputPass at the end of the post-processing chain.
	renderer.toneMapping = AgXToneMapping;
	renderer.toneMappingExposure = 1.05;
	renderer.domElement.setAttribute('aria-hidden', 'true');
	stage.append(renderer.domElement);

	const camera = new PerspectiveCamera(32, 1, 0.1, 40);
	camera.position.set(0, 2.6, 1.4);
	const view = createBookStage(renderer, camera, quality);
	const { scene, fog } = view;

	const book = new Group();
	scene.add(book);

	/* ----- state ----- */
	const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	let reduced = reducedQuery.matches;
	const onReduced = () => (reduced = reducedQuery.matches);
	reducedQuery.addEventListener('change', onReduced);

	let textures: BookTextures | null = null;
	let sheets: Sheet[] = [];
	let spread = 0;
	let maxSpread = 0;
	let hover: 'left' | 'right' | 'book' | null = null;
	let settled = true;
	let frontBoard = 0;
	let rightBlock = BLOCK;
	let leftBlock = 0;
	let openAmount = 0;
	let liftY = 0;
	// Render loop and ambient motion (see "the render loop" below)
	let raf = 0;
	let last = performance.now();
	let visible = false;
	let activeUntil = 0;
	let ambient = false;
	let ambientTime = 0;
	const t0 = performance.now();
	const now = () => (performance.now() - t0) / 1000;
	const pointer = new Vector2();
	const floating: Floating[] = projects.map(() => ({ outer: new Group(), spin: new Group(), amount: 0, state: 'idle' }));

	/* ----- static book parts ----- */
	// Black book cloth and the cream edges of the page block (their fibre
	// normal map is added once the page textures are built)
	const dark = new MeshStandardMaterial({ color: '#141312', roughness: 0.82 });
	const edge = new MeshStandardMaterial({ color: '#e6e0d2', roughness: 0.92 });
	const backBoard = new Mesh(new BoxGeometry(PAGE_W + 0.025, BOARD, PAGE_H + 0.04));
	backBoard.position.set(PAGE_W / 2, BOARD / 2, 0);
	backBoard.castShadow = backBoard.receiveShadow = true;
	const frontBoardMesh = new Mesh(new BoxGeometry(PAGE_W + 0.025, 1, PAGE_H + 0.04), dark);
	frontBoardMesh.position.x = -PAGE_W / 2;
	frontBoardMesh.castShadow = frontBoardMesh.receiveShadow = true;
	frontBoardMesh.visible = false;
	const rightBlockMesh = new Mesh(new BoxGeometry(PAGE_W - 0.012, 1, PAGE_H - 0.014), edge);
	rightBlockMesh.position.x = PAGE_W / 2 - 0.004;
	rightBlockMesh.castShadow = true;
	const leftBlockMesh = new Mesh(new BoxGeometry(PAGE_W - 0.012, 1, PAGE_H - 0.014), edge);
	leftBlockMesh.position.x = -PAGE_W / 2 + 0.004;
	leftBlockMesh.castShadow = true;
	leftBlockMesh.visible = false;
	// Invisible hit area over the whole book, so clicks don't depend on which sheet is on top
	const hitPlane = new Mesh(new PlaneGeometry(PAGE_W * 2 + 0.1, PAGE_H + 0.1), new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
	hitPlane.rotation.x = -Math.PI / 2;
	hitPlane.position.y = 0.12;
	book.add(backBoard, frontBoardMesh, rightBlockMesh, leftBlockMesh, hitPlane);
	// Baked contact shadows where the book meets the mat (see book-scene.ts)
	const contactRight = makeContactShadow(PAGE_W + 0.16, PAGE_H + 0.16, 0.85, 'box');
	contactRight.position.set(PAGE_W / 2, 0.0025, 0);
	const contactLeft = makeContactShadow(PAGE_W + 0.16, PAGE_H + 0.16, 0.85, 'box');
	contactLeft.position.set(-PAGE_W / 2, 0.0025, 0);
	book.add(contactRight, contactLeft);
	for (const f of floating) {
		f.outer.position.set(PAGE_W / 2, 0, 0);
		f.outer.visible = false;
		f.outer.add(f.spin);
		book.add(f.outer);
	}

	function ensureModel(index: number | null) {
		if (index === null) return;
		const f = floating[index];
		const src = projects[index]?.model;
		if (!f || !src || f.state !== 'idle') return;
		f.state = 'loading';
		loader().load(
			src,
			(gltf) => {
				f.spin.add(prepareModel(gltf.scene));
				f.state = 'ready';
				wake(); // a slow download may finish after the loop has gone idle
			},
			undefined,
			() => (f.state = 'failed'), // the page's stage drawing still shows
		);
	}

	/* ----- UI ----- */
	function updateUI() {
		const focused = document.activeElement;
		const atEnd = spread === maxSpread && maxSpread > 0;
		const info = textures?.spreads[spread];
		if (statusEl) statusEl.textContent = spread === 0 ? 'Closed' : `Spread ${String(spread).padStart(2, '0')} / ${String(maxSpread).padStart(2, '0')}`;
		if (labelEl) labelEl.textContent = info?.label ?? 'Loading';
		if (openBtn) {
			openBtn.hidden = spread !== 0;
			openBtn.disabled = !textures;
		}
		if (backBtn) backBtn.hidden = spread === 0;
		if (closeBtn) closeBtn.hidden = spread === 0;
		if (nextBtn) nextBtn.hidden = spread === 0 || atEnd;
		if (quoteLink) quoteLink.hidden = !atEnd;
		if (readLink) {
			readLink.hidden = !info?.url;
			if (info?.url) readLink.href = info.url;
		}
		stage!.classList.toggle('is-pointing', hover !== null && !(hover === 'right' && atEnd));
		// If the button a keyboard user is on just hid itself (Next on the last
		// spread, Open once the book opens), keep focus on a visible button so
		// the arrow keys and Escape still work (the key handler skips links)
		if (focused instanceof HTMLElement && focused.hidden && root.contains(focused)) {
			[nextBtn, backBtn, openBtn].find((el) => el && !el.hidden)?.focus();
		}
	}

	function goTo(next: number) {
		const target = MathUtils.clamp(next, 0, maxSpread);
		if (!sheets.length || target === spread) return;
		const t = now();
		const forward = target > spread;
		// Sheets [0, target) end up turned; flip the ones that change, in order
		const changing: number[] = [];
		sheets.forEach((s, i) => {
			if (s.to !== (i < target ? 1 : 0)) changing.push(i);
		});
		if (!forward) changing.reverse();
		changing.forEach((i, order) => {
			const s = sheets[i];
			s.from = s.p;
			s.to = i < target ? 1 : 0;
			s.start = t + (reduced ? 0 : order * STAGGER_SECONDS);
			s.duration = reduced ? 0 : FLIP_SECONDS * (changing.length > 2 ? 0.7 : 1);
		});
		settled = false; // hide the model straight away; it rises once the pages land
		spread = target;
		wake();
		ensureModel(textures?.spreads[spread]?.modelIndex ?? null);
		ensureModel(textures?.spreads[spread + 1]?.modelIndex ?? null); // the next one, ahead of time
		updateUI();
	}

	openBtn?.addEventListener('click', () => goTo(1));
	backBtn?.addEventListener('click', () => goTo(spread - 1));
	nextBtn?.addEventListener('click', () => goTo(spread + 1));
	closeBtn?.addEventListener('click', () => goTo(0));
	root.addEventListener('keydown', (e) => {
		if (e.target instanceof HTMLElement && e.target.closest('a')) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			goTo(spread + 1);
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			goTo(spread - 1);
		} else if (e.key === 'Escape') {
			goTo(0);
		}
	});

	/* ----- pointer: hover, click and a little parallax ----- */
	const raycaster = new Raycaster();
	const hitPoint = new Vector3();
	function sideAt(e: PointerEvent): typeof hover {
		const rect = renderer.domElement.getBoundingClientRect();
		pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(pointer, camera);
		const hit = raycaster.intersectObject(hitPlane)[0];
		if (!hit || !textures) return null;
		if (spread === 0) return 'book';
		book.worldToLocal(hitPoint.copy(hit.point));
		return hitPoint.x >= 0 ? 'right' : 'left';
	}
	renderer.domElement.addEventListener('pointermove', (e) => {
		wake();
		const side = sideAt(e);
		if (side !== hover) {
			hover = side;
			updateUI();
		}
	});
	renderer.domElement.addEventListener('pointerleave', () => {
		pointer.set(0, 0);
		hover = null;
		updateUI();
		wake(); // let the camera drift back to centre
	});
	renderer.domElement.addEventListener('click', (e) => {
		const side = sideAt(e);
		if (side === 'book') goTo(1);
		else if (side === 'right') goTo(spread + 1);
		else if (side === 'left') goTo(spread - 1);
	});

	/* ----- sizing and the render loop ----- */
	// The stage's edges are masked into the page (ProjectsBook.astro) and the
	// controls sit over the top and bottom, so the book is framed inside the
	// clear middle: these are the fractions of width and height it may use.
	let safeW = 0.78;
	let safeH = 0.76;
	const resize = () => {
		const w = stage.clientWidth;
		const h = stage.clientHeight;
		if (!w || !h) return;
		const phone = w <= 760;
		safeW = phone ? 0.94 : 0.78;
		safeH = phone ? 0.78 : 0.76;
		renderer.setSize(w, h);
		view.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		wake(); // resizing clears the canvas, so draw it again
	};
	new ResizeObserver(resize).observe(stage);
	resize();

	const look = new Vector3();
	const dir = new Vector3(0, 0.88, 0.48).normalize();
	const camTarget = new Vector3();

	function frame(dt: number) {
		const t = now();
		// Page turns
		settled = true;
		let paperTurned = 0;
		sheets.forEach((s, i) => {
			const k = s.duration > 0 ? MathUtils.clamp((t - s.start) / s.duration, 0, 1) : 1;
			if (k < 1) settled = false;
			s.p = s.from + (s.to - s.from) * easeInOut(k);
			// Hover peel: lift the corner of the page you're about to turn
			const peel =
				reduced || k < 1 ? 0 : hover === 'right' && i === spread && spread > 0 ? 0.045 : hover === 'left' && i === spread - 1 && spread > 1 ? -0.045 : 0;
			s.lift = MathUtils.damp(s.lift, peel, 8, dt);
			// A page joins the left-hand stack only as it lands
			if (i > 0) paperTurned += MathUtils.smoothstep(s.p, 0.9, 1);
		});
		const f = paperTurned / Math.max(sheets.length - 1, 1);
		rightBlock = BLOCK * (1 - f);
		leftBlock = BLOCK * f;
		openAmount = sheets[0]?.p ?? 0;
		frontBoard = MathUtils.smoothstep(openAmount, 0.8, 1);
		const board = BOARD * frontBoard;

		frontBoardMesh.scale.y = Math.max(board, 0.0005);
		frontBoardMesh.position.y = frontBoardMesh.scale.y / 2;
		frontBoardMesh.visible = frontBoard > 0.01;
		(contactLeft.material as MeshBasicMaterial).opacity = 0.9 * frontBoard;
		rightBlockMesh.scale.y = Math.max(rightBlock, 0.0005);
		rightBlockMesh.position.y = BOARD + rightBlockMesh.scale.y / 2;
		leftBlockMesh.scale.y = Math.max(leftBlock, 0.0005);
		leftBlockMesh.position.y = 0.004 + board + leftBlockMesh.scale.y / 2;
		leftBlockMesh.visible = leftBlock > 0.001;

		sheets.forEach((s, i) => {
			const p = MathUtils.clamp(s.p + s.lift, 0, 1);
			const onRight = BOARD + rightBlock + (sheets.length - i) * SHEET_GAP;
			const onLeft = i === 0 ? 0.002 + board : 0.004 + board + leftBlock + i * SHEET_GAP + 0.003;
			const base = MathUtils.lerp(onRight, onLeft, p);
			if (Math.abs(p - s.lastP) < 1e-5 && Math.abs(base - s.lastBase) < 1e-6) return;
			s.lastP = p;
			s.lastBase = base;
			bendSheet(s.geometry, p, s.to >= s.from ? 1 : -1, base);
		});

		// Closed, the book sits centred; open, the spine is centred
		liftY = MathUtils.damp(liftY, hover === 'book' && spread === 0 && !reduced ? 0.035 : 0, 8, dt);
		book.position.set(-(PAGE_W / 2) * (1 - openAmount), liftY, 0);
		book.rotation.y = MathUtils.lerp(-0.12, 0, openAmount);

		// Models rise once the page has finished turning, so they don't clip through it
		const active = textures?.spreads[spread]?.modelIndex ?? null;
		floating.forEach((fl, i) => {
			const target = active === i && settled && fl.state === 'ready' ? 1 : 0;
			fl.amount = reduced ? target : MathUtils.damp(fl.amount, target, 5, dt);
			fl.outer.visible = fl.amount > 0.01;
			fl.outer.scale.setScalar(easeInOut(fl.amount));
			fl.outer.position.y = 0.06 + 0.3 * fl.amount + (reduced ? 0 : Math.sin(ambientTime * 1.4) * 0.015);
			if (ambient) fl.spin.rotation.y += dt * 0.45;
		});

		// Camera: frames the closed book, pulls back as it opens, keeping it
		// inside the unmasked middle of the stage (safeW, safeH)
		const halfW = MathUtils.lerp(0.78, 1.18, openAmount) / safeW;
		const halfH = MathUtils.lerp(0.95, 0.85, openAmount) / safeH;
		const tanV = Math.tan(MathUtils.degToRad(camera.fov / 2));
		const dist = Math.max(halfW / (tanV * camera.aspect), halfH / tanV) * 1.04;
		fog.near = dist * 1.15;
		fog.far = dist * 2.4;
		camTarget.copy(dir).multiplyScalar(dist);
		camTarget.x += pointer.x * 0.06;
		camTarget.z += -pointer.y * 0.04;
		camera.position.x = MathUtils.damp(camera.position.x, camTarget.x, 3, dt);
		camera.position.y = MathUtils.damp(camera.position.y, camTarget.y, 3, dt);
		camera.position.z = MathUtils.damp(camera.position.z, camTarget.z, 3, dt);
		look.set(0, 0, 0.05);
		camera.lookAt(look);

		// Focus depth of field on the book: the camera looks at it from `dist` away.
		// The shaders get the ambient clock, so dust, haze and grain hold still
		// while the visitor isn't doing anything.
		view.render(ambientTime, dist, reduced);
	}

	// Render only while the book is on (or near) the screen, and only while
	// something is happening. The ambient motion (dust, beam haze, film grain,
	// the floating model) runs for AMBIENT_MS after the last click, key or
	// pointer move, or after the book scrolls into view, then freezes, so
	// nothing moves on its own for more than five seconds (WCAG 2.2.2).
	// SETTLE_MS more lets the camera and page lifts finish easing, then the
	// loop stops until the next interaction.
	const loop = (ts: number) => {
		const dt = Math.min((ts - last) / 1000, 0.1);
		last = ts;
		ambient = !reduced && ts < activeUntil;
		if (ambient) ambientTime += dt;
		frame(dt);
		raf = visible && (ts < activeUntil + SETTLE_MS || !settled) ? requestAnimationFrame(loop) : 0;
	};
	function wake() {
		activeUntil = performance.now() + AMBIENT_MS;
		if (visible && !raf) {
			last = performance.now();
			raf = requestAnimationFrame(loop);
		}
	}
	new IntersectionObserver(
		([entry]) => {
			visible = entry.isIntersecting;
			cancelAnimationFrame(raf);
			raf = 0;
			if (visible) wake();
		},
		{ rootMargin: '100px' },
	).observe(root);

	/* ----- pages ----- */
	updateUI();
	buildBookTextures(projects).then((built) => {
		textures = built;
		maxSpread = built.sheetFronts.length;
		// Paper fibre: the same normal map on every page surface and the page edges
		for (const m of [dark, edge]) {
			m.normalMap = built.paperNormal;
			m.normalScale.setScalar(m === dark ? 0.6 : 0.3);
			m.needsUpdate = true;
		}
		backBoard.material = [dark, dark, new MeshStandardMaterial({ map: built.backCoverInside, roughness: 0.9 }), dark, dark, dark];
		sheets = built.sheetFronts.map((front, i) => {
			const geometry = makeSheetGeometry();
			const isCover = i === 0;
			const paper = isCover ? 0.6 : 0.92;
			// The cover's foil lettering is metal and smooth, its cloth matte (the
			// metal/rough map decides per pixel); pages are matte paper with fibre
			const frontMaterial = isCover
				? new MeshStandardMaterial({
						map: front,
						metalnessMap: built.coverMetalRough,
						roughnessMap: built.coverMetalRough,
						metalness: 1,
						roughness: 1,
						normalMap: built.paperNormal,
						normalScale: new Vector2(0.6, 0.6),
					})
				: new MeshStandardMaterial({ map: front, roughness: paper, normalMap: built.paperNormal, normalScale: new Vector2(0.18, 0.18) });
			const frontMesh = new Mesh(geometry, frontMaterial);
			const backMesh = new Mesh(
				geometry,
				new MeshStandardMaterial({ map: built.sheetBacks[i], roughness: paper, side: BackSide, normalMap: built.paperNormal, normalScale: new Vector2(0.18, 0.18) }),
			);
			for (const m of [frontMesh, backMesh]) {
				m.castShadow = true;
				m.receiveShadow = true;
			}
			book.add(frontMesh, backMesh);
			return { geometry, p: 0, from: 0, to: 0, start: 0, duration: 0, lift: 0, lastP: -1, lastBase: -1 };
		});
		updateUI();
		wake(); // draw the finished pages
	});
}

