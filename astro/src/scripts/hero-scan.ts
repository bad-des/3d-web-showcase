/*
 * The home hero's 3D model, told as the service it sells: scan, then CAD.
 *
 *  1. SCAN. Loose points drift like dust. A thin plane of laser light sweeps
 *     up the part; every point it passes is captured onto the part's real
 *     surface (sampled from the GLB), so a point cloud builds from the bottom.
 *  2. CAD. A second sweep follows, revealing the solid model under a clipping
 *     plane while the points it passes fade out.
 *  3. The turntable eases to a stop at about 5 seconds; after that, drag or
 *     the arrow keys turn it. (Why it moves at all: the motion is the
 *     service itself, scan then CAD, told in under five seconds.)
 *
 * Plain three.js, loaded by index.astro only once the hero is in view and the
 * page has finished loading. Renders only while on screen; phones get fewer
 * points and a lower pixel ratio; reduced motion skips straight to the
 * finished model with no auto-rotate. Returns false without WebGL, so the
 * page can fall back to <model-viewer>.
 *
 * Idea from scan-to-mesh point-cloud demos (particles.casberry.in, ThreeUI's
 * particle pieces); the code is written for this site, in the style of the
 * dust in book-scene.ts.
 */

import {
	AdditiveBlending,
	AgXToneMapping,
	Box3,
	BufferAttribute,
	BufferGeometry,
	CircleGeometry,
	Color,
	DirectionalLight,
	DoubleSide,
	Group,
	HemisphereLight,
	MathUtils,
	Mesh,
	MeshStandardMaterial,
	PMREMGenerator,
	PerspectiveCamera,
	Plane,
	Points,
	Scene,
	ShaderMaterial,
	Sphere,
	Vector3,
	WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Seeded PRNG (same as book-scene.ts; copied so this chunk doesn't pull in the book's scene) */
function seeded(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const DRACO_DECODERS = '/vendor/draco/';
const TAN = '#b9a16f';
const WINE_LIGHT = '#c0566a'; // the burgundy token, lifted so it reads as light on a dark stage
const CAD_COLOR = '#d9cfbd'; // a warm, matte print-resin grey

// Timeline, in seconds after the model appears
const SCAN = [0.3, 2.6];
const CAD = [2.3, 4.1];
const AUTO_ROTATE = MathUtils.degToRad(18); // per second, as the old model-viewer hero
// The turntable eases to a stop here, so nothing on the page moves on its own
// for more than 5 seconds (WCAG 2.2.2) and the GPU goes idle; drag or the
// arrow keys turn it after that
const SPIN_EASE = [3.6, 4.9];
const KEY_STEP = MathUtils.degToRad(20);

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** -1.15 to 1.15 (just past the part's normalised height) as t runs through [a, b] */
const sweep = (t: number, [a, b]: number[]) => MathUtils.lerp(-1.15, 1.15, easeInOut(MathUtils.clamp((t - a) / (b - a), 0, 1)));

/** One geometry of the whole model in its own space, positions only, centred and scaled to fit a unit sphere */
function flatten(root: Group) {
	root.updateMatrixWorld(true);
	const parts: BufferGeometry[] = [];
	root.traverse((o) => {
		const mesh = o as Mesh;
		if (!mesh.isMesh) return;
		const g = new BufferGeometry();
		g.setAttribute('position', mesh.geometry.getAttribute('position').clone());
		if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
		g.applyMatrix4(mesh.matrixWorld);
		parts.push(g.index ? g.toNonIndexed() : g);
	});
	const merged = mergeGeometries(parts)!;
	const box = new Box3().setFromBufferAttribute(merged.getAttribute('position') as BufferAttribute);
	const centre = box.getCenter(new Vector3());
	merged.translate(-centre.x, -centre.y, -centre.z);
	merged.computeBoundingSphere();
	const r = merged.boundingSphere!.radius || 1;
	merged.scale(1 / r, 1 / r, 1 / r);
	merged.computeVertexNormals();
	merged.computeBoundingSphere();
	return merged;
}

function buildCloud(surface: BufferGeometry, count: number) {
	const sampler = new MeshSurfaceSampler(new Mesh(surface)).build();
	const rand = seeded(7);
	const target = new Float32Array(count * 3);
	const start = new Float32Array(count * 3);
	const seed = new Float32Array(count);
	const wine = new Float32Array(count);
	const p = new Vector3();
	for (let i = 0; i < count; i++) {
		sampler.sample(p);
		target.set([p.x, p.y, p.z], i * 3);
		// Start: a loose cloud around the part, wider than it
		const a = rand() * Math.PI * 2;
		const r = 0.6 + Math.sqrt(rand()) * 1.1;
		start.set([Math.cos(a) * r, (rand() - 0.5) * 2.2, Math.sin(a) * r], i * 3);
		seed[i] = rand();
		wine[i] = rand() < 0.08 ? 1 : 0; // a few burgundy points among the tan
	}
	const g = new BufferGeometry();
	g.setAttribute('position', new BufferAttribute(target, 3));
	g.setAttribute('aStart', new BufferAttribute(start, 3));
	g.setAttribute('aSeed', new BufferAttribute(seed, 1));
	g.setAttribute('aWine', new BufferAttribute(wine, 1));
	g.boundingSphere = new Sphere(new Vector3(), 2.4);

	const material = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		premultipliedAlpha: true, // additive in colour and alpha, on a transparent canvas
		uniforms: {
			uTime: { value: 0 },
			uScan: { value: -1.15 }, // height of the scan plane (normalised model space)
			uCad: { value: -1.15 }, // height of the CAD reveal
			uPixelRatio: { value: 1 },
			uTan: { value: new Color(TAN) },
			uWine: { value: new Color(WINE_LIGHT) },
		},
		vertexShader: /* glsl */ `
			attribute vec3 aStart;
			attribute float aSeed;
			attribute float aWine;
			uniform float uTime;
			uniform float uScan;
			uniform float uCad;
			uniform float uPixelRatio;
			varying float vAlpha;
			varying float vWine;

			void main() {
				// Loose points wander slowly, like the dust under the book's lamp
				vec3 loose = aStart + vec3(
					sin(uTime * 0.31 + aSeed * 40.0),
					sin(uTime * 0.23 + aSeed * 61.0),
					cos(uTime * 0.27 + aSeed * 23.0)) * 0.06;

				// Captured once the scan plane has passed this point's height,
				// each with a slightly different flight time
				float captured = smoothstep(0.0, 0.28 + aSeed * 0.2, uScan - position.y);
				vec3 p = mix(loose, position, captured);

				// Bright where the laser is right now
				float band = 1.0 - smoothstep(0.0, 0.07, abs(position.y - uScan));
				// Gone once the CAD reveal has passed: the solid takes over
				float solid = smoothstep(uCad - 0.12, uCad, position.y);

				vAlpha = mix(0.22, 0.75, captured) * solid + band * captured * 0.9;
				vWine = aWine;

				vec4 mv = modelViewMatrix * vec4(p, 1.0);
				gl_Position = projectionMatrix * mv;
				gl_PointSize = (1.4 + aSeed * 1.4 + band * 2.0) * uPixelRatio * (4.0 / -mv.z);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uTan;
			uniform vec3 uWine;
			varying float vAlpha;
			varying float vWine;
			void main() {
				float soft = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5));
				// Premultiplied: the canvas is transparent, so alpha must carry the
				// light too, or the dark corners of each point would cover the page
				float a = soft * vAlpha;
				gl_FragColor = vec4(mix(uTan, uWine, vWine) * a, a);
			}
		`,
	});
	const points = new Points(g, material);
	points.frustumCulled = false; // positions move in the shader
	return { points, material };
}

/** The laser: a soft, flat disc of tan light at the scan height */
function buildLaser() {
	const material = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		premultipliedAlpha: true, // additive in colour and alpha, on a transparent canvas
		side: DoubleSide,
		uniforms: { uColor: { value: new Color(TAN) }, uOpacity: { value: 0 } },
		vertexShader: /* glsl */ `
			varying vec2 vUv;
			void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			uniform float uOpacity;
			varying vec2 vUv;
			void main() {
				float r = length(vUv - 0.5) * 2.0;
				float fill = (1.0 - smoothstep(0.0, 1.0, r)) * 0.18;
				float ring = smoothstep(0.86, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r)) * 0.5;
				float a = (fill + ring) * uOpacity;
				gl_FragColor = vec4(uColor * a, a);
			}
		`,
	});
	const laser = new Mesh(new CircleGeometry(1.15, 64), material);
	laser.rotation.x = -Math.PI / 2;
	return { laser, material };
}

export async function mountHeroScan(el: HTMLElement): Promise<boolean> {
	const src = el.dataset.src;
	if (!src) return false;

	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ antialias: true, alpha: true });
	} catch {
		return false;
	}
	const small = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
	const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 2));
	renderer.setClearColor(0x000000, 0); // the stage's CSS glow shows through
	renderer.toneMapping = AgXToneMapping;
	renderer.localClippingEnabled = true;

	const draco = new DRACOLoader();
	draco.setDecoderPath(DRACO_DECODERS);
	const loader = new GLTFLoader();
	loader.setDRACOLoader(draco);
	let surface: BufferGeometry;
	try {
		const gltf = await loader.loadAsync(src);
		surface = flatten(gltf.scene);
	} catch {
		renderer.dispose();
		return false;
	} finally {
		draco.dispose();
	}

	const scene = new Scene();
	const pmrem = new PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	scene.environmentIntensity = 0.35;
	pmrem.dispose();
	scene.add(new HemisphereLight('#f2e6cf', '#2a1d14', 0.9));
	const key = new DirectionalLight('#ffd9a6', 2.4); // the warm desk-lamp key, as on /projects/
	key.position.set(-2, 3, 2.5);
	const rim = new DirectionalLight(WINE_LIGHT, 1.6); // a burgundy edge light from behind
	rim.position.set(2.5, 1.2, -3);
	scene.add(key, rim);

	const turntable = new Group();
	scene.add(turntable);

	// Solid CAD model, revealed from the bottom by a clipping plane (keeps y < constant)
	const clip = new Plane(new Vector3(0, -1, 0), -1.15);
	const solid = new Mesh(
		surface,
		new MeshStandardMaterial({ color: CAD_COLOR, roughness: 0.55, metalness: 0.05, side: DoubleSide, clippingPlanes: [clip] }),
	);
	const { points, material: cloud } = buildCloud(surface, small ? 5000 : 12000);
	const { laser, material: laserMaterial } = buildLaser();
	turntable.add(solid, points);
	scene.add(laser); // world space: stays level while the part turns

	// Camera: the old hero's orbit (30deg around, 70deg down from the top)
	const camera = new PerspectiveCamera(30, 1, 0.1, 50);
	const theta = MathUtils.degToRad(30);
	const phi = MathUtils.degToRad(70);
	const distance = 1.3 / Math.sin(MathUtils.degToRad(15));
	camera.position.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)).multiplyScalar(distance);
	camera.lookAt(0, 0, 0);

	const canvas = renderer.domElement;
	canvas.setAttribute('aria-hidden', 'true');
	canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;cursor:grab';
	// Focusable, so keyboard users can turn it too (drag needs a pointer)
	el.tabIndex = 0;
	el.setAttribute('role', 'group');
	el.setAttribute('aria-roledescription', '3D model viewer');
	el.setAttribute('aria-label', `${el.dataset.alt ?? '3D model'}. Use the left and right arrow keys to rotate.`);
	el.append(canvas);
	el.addEventListener('keydown', (e) => {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		e.preventDefault();
		turntable.rotation.y += e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP;
		requestRender();
	});

	const resize = () => {
		const w = el.clientWidth;
		const h = el.clientHeight;
		if (!w || !h) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		cloud.uniforms.uPixelRatio.value = renderer.getPixelRatio();
		requestRender();
	};

	/* ----- drag to rotate ----- */
	let dragging = false;
	let lastX = 0;
	canvas.addEventListener('pointerdown', (e) => {
		dragging = true;
		lastX = e.clientX;
		canvas.setPointerCapture(e.pointerId);
		canvas.style.cursor = 'grabbing';
	});
	canvas.addEventListener('pointermove', (e) => {
		if (!dragging) return;
		turntable.rotation.y += ((e.clientX - lastX) / Math.max(el.clientWidth, 1)) * Math.PI * 1.5;
		lastX = e.clientX;
		requestRender();
	});
	const endDrag = () => {
		dragging = false;
		canvas.style.cursor = 'grab';
	};
	canvas.addEventListener('pointerup', endDrag);
	canvas.addEventListener('pointercancel', endDrag);

	/* ----- the loop: runs while on screen and something is moving ----- */
	let visible = false;
	let raf = 0;
	let last = 0;
	let startedAt = -1; // the timeline starts the first time it's seen
	let finished = false;

	function frame(now: number) {
		raf = 0;
		const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
		last = now;
		const reduced = reducedQuery.matches;
		if (startedAt < 0) startedAt = now;
		const t = reduced ? CAD[1] + 1 : (now - startedAt) / 1000;

		const scanY = sweep(t, SCAN);
		const cadY = sweep(t, CAD);
		cloud.uniforms.uTime.value = t;
		cloud.uniforms.uScan.value = scanY;
		cloud.uniforms.uCad.value = cadY;
		clip.constant = cadY;
		laser.position.y = scanY;
		laserMaterial.uniforms.uOpacity.value = MathUtils.smoothstep(t, SCAN[0], SCAN[0] + 0.3) * (1 - MathUtils.smoothstep(t, SCAN[1] - 0.3, SCAN[1]));
		finished = t >= CAD[1] + 0.1;
		points.visible = laser.visible = !finished;
		if (finished) clip.constant = 10; // fully solid; nothing left to clip

		const spin = reduced || dragging ? 0 : 1 - MathUtils.smoothstep(t, SPIN_EASE[0], SPIN_EASE[1]);
		turntable.rotation.y += AUTO_ROTATE * spin * dt;
		renderer.render(scene, camera);

		const moving = !finished || spin > 0 || dragging;
		if (visible && moving) raf = requestAnimationFrame(frame);
		else last = 0;
	}
	function requestRender() {
		if (!raf) raf = requestAnimationFrame(frame);
	}

	new ResizeObserver(resize).observe(el);
	resize();
	new IntersectionObserver(([entry]) => {
		visible = entry.isIntersecting;
		if (visible) requestRender();
		else {
			cancelAnimationFrame(raf);
			raf = 0;
			last = 0;
		}
	}).observe(el);
	reducedQuery.addEventListener('change', requestRender);
	return true;
}
