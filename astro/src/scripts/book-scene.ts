/*
 * The set for the projects book (portfolio-book.ts): a dark room, a walnut
 * desk, a cutting mat, and one brass desk lamp. Everything that makes the
 * picture look real lives here, so this file doubles as a reference for how
 * realistic rendering works in three.js. In the order it happens:
 *
 *  1. LIGHT THAT BEHAVES LIKE LIGHT. One warm spotlight inside the lamp shade,
 *     with physically based falloff (intensity in candela, `decay = 2`, the
 *     inverse-square law) and soft shadows. A very dim cool hemisphere light
 *     stands in for moonlight from a window so the shadows aren't pure black.
 *
 *  2. IMAGE-BASED LIGHTING (IBL). Real surfaces reflect their surroundings,
 *     not just the lights. `RoomEnvironment` is a small room built in code
 *     that three.js pre-blurs (PMREM) into an environment map; every
 *     MeshStandard/PhysicalMaterial then reflects it. Kept very dim
 *     (`environmentIntensity`) because this room is meant to be dark. To use
 *     a real HDRI instead, load it with three's HDRLoader and assign it to
 *     `scene.environment` the same way.
 *
 *  3. PBR MATERIALS + MAPS. Base colour alone looks like plastic. Here:
 *     - walnut desk: colour map + roughness map (grain varies satin/dull)
 *     - cutting mat: colour + roughness
 *     - china cup: MeshPhysicalMaterial with clearcoat (a glaze layer)
 *     - brass lamp and pen tip: metalness 1, so they tint their reflections
 *     - paper and cover: a normal map of fibre grain (made in book-pages.ts)
 *     - gold foil on the cover: a metalness/roughness map so ONLY the foil
 *       is metal
 *     All maps are drawn on <canvas>, so there's nothing extra to download.
 *
 *  4. BAKED CONTACT SHADOWS. Real objects darken the surface right where they
 *     touch it (ambient occlusion). Computing that live (SSAO) is too heavy
 *     for phones, so it's "baked" into soft radial textures laid under the
 *     book, cup and lamp: zero cost per frame. (Static props could later be
 *     fully baked in Blender, the gold-standard approach.)
 *
 *  5. TONE MAPPING. Lit pixels can be far brighter than a screen can show.
 *     AgX maps that range down like film does, keeping the lamp's hot spot
 *     from clipping to flat white or shifting hue.
 *
 *  6. POST-PROCESSING (EffectComposer). The frame is rendered to an HDR
 *     buffer, then:
 *       depth of field (desktop) -> bloom -> tone mapping -> lens shader
 *     Depth of field keeps the book sharp and softens the desk edges; bloom
 *     makes only the brightest highlights (the bulb, glints) glow.
 *
 *  7. HAND-WRITTEN SHADERS (GLSL). Three effects no built-in material does:
 *     - BEAM: a soft volumetric cone of lamp light (fades at its edges and
 *       toward the desk, with slow drifting haze)
 *     - DUST: motes that drift and twinkle, lit only while inside the beam
 *     - LENS: vignette and animated film grain, applied last like a camera
 *     Each shader is commented line by line below.
 */

import {
	AdditiveBlending,
	Color,
	CylinderGeometry,
	ConeGeometry,
	CircleGeometry,
	DoubleSide,
	Float32BufferAttribute,
	Fog,
	Group,
	HalfFloatType,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	CanvasTexture,
	PlaneGeometry,
	BufferGeometry,
	Points,
	PMREMGenerator,
	RepeatWrapping,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	SpotLight,
	SRGBColorSpace,
	TorusGeometry,
	Vector2,
	Vector3,
	WebGLRenderTarget,
	type PerspectiveCamera,
	type Texture,
	type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// The room beyond the lamp: the page background (--bg in global.css), so the
// scene's edges fade into the page with no visible panel (ProjectsBook.astro)
export const BACKGROUND = '#14110e';

const LAMP_LIGHT = '#ffd9a6'; // a warm ~2700 K bulb

// Where the lamp sits and what it points at (book spine is at x = 0)
const LAMP_BASE = new Vector3(1.38, 0, -0.82);
const LAMP_ELBOW = new Vector3(1.3, 0.92, -0.95);
const LAMP_HEAD = new Vector3(0.95, 1.42, -0.52);
const LAMP_TARGET = new Vector3(0.05, 0, 0.08);
const BEAM_ANGLE = 0.56; // spotlight half-angle, radians

/** "high" on desktops; "low" on phones and small screens (no depth of field, fewer samples) */
export type Quality = 'high' | 'low';

/** Seeded PRNG so procedural textures are the same on every visit */
export function seeded(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function canvas(w: number, h: number) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return { c, ctx: c.getContext('2d')! };
}

/* ---------- procedural textures ---------- */

/** Walnut boards: a colour map plus a matching roughness map (darker = shinier) */
function makeWalnut() {
	const W = 1024;
	const color = canvas(W, W);
	const rough = canvas(W, W);
	const rand = seeded(17);
	color.ctx.fillStyle = '#2a1c13';
	color.ctx.fillRect(0, 0, W, W);
	rough.ctx.fillStyle = 'rgb(150,150,150)'; // roughness ~0.6 where there's no grain
	rough.ctx.fillRect(0, 0, W, W);
	// Grain: long wavy lines, darker and lighter, with matching roughness
	for (let i = 0; i < 340; i++) {
		const y = rand() * W;
		const dark = rand() < 0.6;
		const a = 0.05 + rand() * 0.12;
		const lw = 0.6 + rand() * 3.2;
		const phase = rand() * 10;
		for (const [ctx, style] of [
			[color.ctx, dark ? `rgba(10,5,2,${a})` : `rgba(120,80,48,${a * 0.7})`],
			[rough.ctx, dark ? `rgba(220,220,220,${a * 1.5})` : `rgba(70,70,70,${a * 1.5})`],
		] as const) {
			ctx.strokeStyle = style;
			ctx.lineWidth = lw;
			ctx.beginPath();
			ctx.moveTo(0, y);
			for (let x = 0; x <= W; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.006 + phase) * 14 + Math.sin(x * 0.03 + phase) * 2);
			ctx.stroke();
		}
	}
	// Board seams every quarter
	for (const y of [W / 4, W / 2, (3 * W) / 4]) {
		color.ctx.fillStyle = 'rgba(0,0,0,0.55)';
		color.ctx.fillRect(0, y, W, 3);
	}
	const map = new CanvasTexture(color.c);
	map.colorSpace = SRGBColorSpace;
	const roughnessMap = new CanvasTexture(rough.c); // data, not colour: stays linear
	for (const t of [map, roughnessMap]) {
		t.wrapS = t.wrapT = RepeatWrapping;
		t.repeat.set(2.5, 2.5);
		t.anisotropy = 8;
	}
	return { map, roughnessMap };
}

/** Charcoal self-healing cutting mat with a tan printed grid */
function makeMat() {
	const { c, ctx } = canvas(2048, 1448);
	const rand = seeded(3);
	ctx.fillStyle = '#1f1e1c';
	ctx.fillRect(0, 0, c.width, c.height);
	for (let i = 0; i < 16000; i++) {
		ctx.fillStyle = `rgba(255,255,255,${rand() * 0.025})`;
		ctx.fillRect(rand() * c.width, rand() * c.height, 2, 2);
	}
	const step = 2048 / 34;
	for (let i = 0, x = 60; x < c.width - 40; i++, x += step) {
		ctx.fillStyle = i % 5 === 0 ? 'rgba(185,161,111,0.42)' : 'rgba(185,161,111,0.16)';
		ctx.fillRect(x, 60, i % 5 === 0 ? 2.5 : 1.5, c.height - 120);
	}
	for (let i = 0, y = 60; y < c.height - 40; i++, y += step) {
		ctx.fillStyle = i % 5 === 0 ? 'rgba(185,161,111,0.42)' : 'rgba(185,161,111,0.16)';
		ctx.fillRect(60, y, c.width - 120, i % 5 === 0 ? 2.5 : 1.5);
	}
	ctx.strokeStyle = 'rgba(185,161,111,0.7)';
	ctx.lineWidth = 3;
	ctx.setLineDash([18, 12]);
	ctx.beginPath();
	ctx.moveTo(60, c.height - 160);
	ctx.lineTo(c.width - 60, 160);
	ctx.stroke();
	const t = new CanvasTexture(c);
	t.colorSpace = SRGBColorSpace;
	t.anisotropy = 8;
	return t;
}

/** Soft radial falloff used for every baked contact shadow (white = opaque) */
let contactTexture: CanvasTexture | undefined;
function contactShadowTexture() {
	if (contactTexture) return contactTexture;
	const { c, ctx } = canvas(256, 256);
	const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 256, 256);
	contactTexture = new CanvasTexture(c);
	return contactTexture;
}

/** The same, for box-shaped things: a blurred rectangle (soft all round, square-cornered) */
let boxContactTexture: CanvasTexture | undefined;
function boxContactShadowTexture() {
	if (boxContactTexture) return boxContactTexture;
	const { c, ctx } = canvas(256, 256);
	ctx.filter = 'blur(14px)';
	ctx.fillStyle = 'white';
	ctx.fillRect(36, 36, 184, 184);
	boxContactTexture = new CanvasTexture(c);
	return boxContactTexture;
}

/**
 * A baked contact shadow: a flat, darkening decal on the desk, stretched to
 * the object's footprint. "round" for cups and lamp bases, "box" for the book.
 */
export function makeContactShadow(width: number, depth: number, opacity = 0.85, shape: 'round' | 'box' = 'round') {
	const m = new Mesh(
		new PlaneGeometry(width, depth),
		new MeshBasicMaterial({
			color: '#000000',
			alphaMap: shape === 'box' ? boxContactShadowTexture() : contactShadowTexture(),
			transparent: true,
			opacity,
			depthWrite: false,
		}),
	);
	m.rotation.x = -Math.PI / 2;
	m.renderOrder = 1; // after the desk, before anything standing on it
	return m;
}

/* ---------- props ---------- */

const brass = () => new MeshStandardMaterial({ color: '#c9a465', metalness: 1, roughness: 0.32 });
const blackenedSteel = () => new MeshStandardMaterial({ color: '#141312', metalness: 0.6, roughness: 0.45 });

/** A cylinder from point a to point b (for the lamp's arms) */
function rod(a: Vector3, b: Vector3, radius: number, material: MeshStandardMaterial) {
	const len = a.distanceTo(b);
	const m = new Mesh(new CylinderGeometry(radius, radius, len, 20), material);
	m.position.copy(a).lerp(b, 0.5);
	m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
	m.castShadow = true;
	return m;
}

function buildLamp() {
	const lamp = new Group();
	const metal = brass();
	const steel = blackenedSteel();
	const base = new Mesh(new CylinderGeometry(0.2, 0.22, 0.035, 48), steel);
	base.position.copy(LAMP_BASE).setY(0.0175);
	base.castShadow = base.receiveShadow = true;
	const collar = new Mesh(new CylinderGeometry(0.035, 0.035, 0.06, 24), metal);
	collar.position.copy(LAMP_BASE).setY(0.065);
	const lower = rod(LAMP_BASE.clone().setY(0.06), LAMP_ELBOW, 0.012, metal);
	const upper = rod(LAMP_ELBOW, LAMP_HEAD, 0.011, metal);
	const knuckle = new Mesh(new SphereGeometry(0.026, 20, 16), metal);
	knuckle.position.copy(LAMP_ELBOW);

	// Shade: a cone opening toward the target. Blackened outside, brass rim,
	// and a warm, glowing inside.
	const dir = LAMP_TARGET.clone().sub(LAMP_HEAD).normalize();
	const shade = new Group();
	shade.position.copy(LAMP_HEAD);
	shade.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), dir);
	const outside = new Mesh(new ConeGeometry(0.17, 0.22, 48, 1, true), new MeshStandardMaterial({ color: '#121110', metalness: 0.5, roughness: 0.4, side: DoubleSide }));
	outside.rotation.x = Math.PI; // ConeGeometry points +Y; flip so it opens downward
	outside.position.y = -0.07;
	const rim = new Mesh(new TorusGeometry(0.168, 0.006, 10, 64), metal);
	rim.rotation.x = Math.PI / 2;
	rim.position.y = -0.18;
	// The bulb: an emissive sphere bright enough (>1 in HDR) to bloom
	const bulb = new Mesh(new SphereGeometry(0.045, 24, 16), new MeshBasicMaterial({ color: new Color(LAMP_LIGHT).multiplyScalar(14) }));
	bulb.position.y = -0.1;
	shade.add(outside, rim, bulb);
	lamp.add(base, collar, lower, upper, knuckle, shade);

	const contact = makeContactShadow(0.62, 0.62, 0.9);
	contact.position.copy(LAMP_BASE).setY(0.003);
	lamp.add(contact);
	return lamp;
}

function buildCup() {
	const cup = new Group();
	// Glazed china: a clearcoat layer on top of a matte body, like real glaze
	const china = new MeshPhysicalMaterial({ color: '#efe9de', roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08 });
	const saucer = new Mesh(new CylinderGeometry(0.24, 0.2, 0.016, 64), china);
	saucer.position.y = 0.008;
	const body = new Mesh(new CylinderGeometry(0.13, 0.095, 0.17, 64, 1, true), new MeshPhysicalMaterial({ color: '#efe9de', roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.08, side: DoubleSide }));
	body.position.y = 0.1;
	const coffee = new Mesh(new CircleGeometry(0.122, 48), new MeshPhysicalMaterial({ color: '#1e120a', roughness: 0.05, clearcoat: 1 }));
	coffee.position.y = 0.165;
	coffee.rotation.x = -Math.PI / 2;
	const handle = new Mesh(new TorusGeometry(0.045, 0.013, 12, 24, Math.PI), china);
	handle.position.set(0.15, 0.11, 0);
	handle.rotation.z = Math.PI / 2;
	for (const m of [saucer, body, handle]) m.castShadow = m.receiveShadow = true;
	const contact = makeContactShadow(0.58, 0.58, 0.8);
	contact.position.y = 0.002;
	cup.add(contact, saucer, body, coffee, handle);
	cup.position.set(-1.55, 0, -0.35);
	cup.rotation.y = 0.5;
	return cup;
}

function buildPen() {
	const pen = new Group();
	const barrel = new Mesh(new CylinderGeometry(0.016, 0.016, 0.62, 24), new MeshPhysicalMaterial({ color: '#0e0e10', roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }));
	const tip = new Mesh(new ConeGeometry(0.016, 0.06, 24), brass());
	tip.position.y = -0.34;
	tip.rotation.x = Math.PI;
	const clip = new Mesh(new CylinderGeometry(0.004, 0.004, 0.16, 8), brass());
	clip.position.set(0.018, 0.2, 0);
	barrel.castShadow = tip.castShadow = true;
	pen.add(barrel, tip, clip);
	pen.position.set(1.32, 0.018, 0.42);
	pen.rotation.set(0, -0.5, Math.PI / 2);
	const contact = makeContactShadow(0.7, 0.09, 0.6);
	contact.position.set(1.32, 0.002, 0.42);
	contact.rotation.z = 0.5 - Math.PI / 2;
	return [pen, contact];
}

function buildTargets() {
	const g = new Group();
	for (const [x, z] of [
		[-1.45, 0.42],
		[-1.26, 0.56],
	]) {
		const dot = new Mesh(new CircleGeometry(0.07, 40), new MeshStandardMaterial({ color: '#0a0a0a', roughness: 0.7 }));
		dot.rotation.x = -Math.PI / 2;
		dot.position.set(x, 0.004, z);
		const hole = new Mesh(new CircleGeometry(0.028, 32), new MeshStandardMaterial({ color: '#ece6d8', roughness: 0.6 }));
		hole.rotation.x = -Math.PI / 2;
		hole.position.set(x, 0.005, z);
		dot.receiveShadow = hole.receiveShadow = true;
		g.add(dot, hole);
	}
	return g;
}

/* ---------- shader 1: the volumetric light beam ---------- */

function buildBeam() {
	const length = LAMP_HEAD.distanceTo(LAMP_TARGET) * 1.05;
	const radius = Math.tan(BEAM_ANGLE) * length * 0.82;
	// An open cone from the bulb (apex) down to the desk
	const geometry = new ConeGeometry(radius, length, 64, 1, true);
	geometry.translate(0, -length / 2, 0); // apex at the origin, opening downward

	const material = new ShaderMaterial({
		transparent: true,
		depthWrite: false, // a glow, not a surface: never hide what's behind it
		blending: AdditiveBlending, // light adds to whatever is behind it
		side: DoubleSide, // front and back walls both add, so it reads as a volume
		uniforms: {
			uColor: { value: new Color(LAMP_LIGHT) },
			uOpacity: { value: 0.07 },
			uTime: { value: 0 },
		},
		vertexShader: /* glsl */ `
			// ConeGeometry's uv.y runs 0 at the wide end (desk) to 1 at the apex (bulb)
			varying float vHeight;
			varying vec3 vNormal;   // surface normal, in view space
			varying vec3 vViewDir;  // direction from the surface to the camera, view space
			varying vec3 vLocal;    // position inside the cone, for the haze pattern

			void main() {
				vHeight = uv.y;
				vLocal = position;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vNormal = normalize(normalMatrix * normal);
				vViewDir = normalize(-mv.xyz);
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			uniform float uOpacity;
			uniform float uTime;
			varying float vHeight;
			varying vec3 vNormal;
			varying vec3 vViewDir;
			varying vec3 vLocal;

			void main() {
				// 1. Soft edges. Where the cone wall faces the camera we look through
				//    the most "air", so it's brightest; at the silhouette the wall is
				//    edge-on, so it fades to nothing. (A "fresnel" style term.)
				float facing = abs(dot(normalize(vNormal), normalize(vViewDir)));
				float edges = smoothstep(0.0, 0.75, facing);

				// 2. Falloff along the beam: strongest near the bulb, gone before it
				//    reaches the desk (so it never looks like a solid cone).
				float along = smoothstep(0.0, 0.55, vHeight) * (0.35 + 0.65 * vHeight);

				// 3. Haze: two slow sine waves drifting through the beam, so the
				//    light seems to pass through moving air rather than glass.
				float haze = 0.82 + 0.18 * sin(vLocal.y * 9.0 + uTime * 0.6) * sin(vLocal.x * 7.0 - uTime * 0.4);

				gl_FragColor = vec4(uColor * uOpacity * edges * along * haze, 1.0);
			}
		`,
	});
	const beam = new Mesh(geometry, material);
	beam.position.copy(LAMP_HEAD);
	beam.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), LAMP_TARGET.clone().sub(LAMP_HEAD).normalize());
	beam.renderOrder = 10; // after the opaque scene
	return { beam, material };
}

/* ---------- shader 2: dust motes drifting through the beam ---------- */

function buildDust(count: number) {
	const rand = seeded(41);
	const axis = LAMP_TARGET.clone().sub(LAMP_HEAD).normalize();
	const length = LAMP_HEAD.distanceTo(LAMP_TARGET);
	// Two directions perpendicular to the beam, for scattering points across it
	const side = new Vector3(1, 0, 0).cross(axis).normalize();
	const up = axis.clone().cross(side).normalize();
	const positions: number[] = [];
	const seeds: number[] = [];
	for (let i = 0; i < count; i++) {
		const h = (0.12 + rand() * 0.8) * length; // distance down the beam
		const r = Math.sqrt(rand()) * Math.tan(BEAM_ANGLE) * h * 0.9; // sqrt: even spread across the disc
		const a = rand() * Math.PI * 2;
		const p = LAMP_HEAD.clone()
			.addScaledVector(axis, h)
			.addScaledVector(side, Math.cos(a) * r)
			.addScaledVector(up, Math.sin(a) * r);
		positions.push(p.x, p.y, p.z);
		seeds.push(rand());
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
	geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1));

	const material = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		uniforms: {
			uTime: { value: 0 },
			uMotion: { value: 1 }, // 0 when the visitor prefers reduced motion
			uPixelRatio: { value: 1 },
			uColor: { value: new Color(LAMP_LIGHT) },
			uApex: { value: LAMP_HEAD.clone() },
			uAxis: { value: axis },
			uTan: { value: Math.tan(BEAM_ANGLE) },
		},
		vertexShader: /* glsl */ `
			attribute float aSeed;   // one random number per mote, 0..1
			uniform float uTime;
			uniform float uMotion;
			uniform float uPixelRatio;
			uniform vec3 uApex;      // the bulb
			uniform vec3 uAxis;      // the beam's direction
			uniform float uTan;      // tan(beam half-angle): radius per unit of length
			varying float vLight;

			void main() {
				// Drift: each mote wanders on its own slow loop (different speeds
				// and phases from its seed), mostly sinking, like real dust.
				float t = uTime * uMotion;
				vec3 p = position;
				p.x += sin(t * 0.13 + aSeed * 40.0) * 0.035;
				p.z += cos(t * 0.11 + aSeed * 23.0) * 0.035;
				p.y += sin(t * 0.07 + aSeed * 61.0) * 0.05 - mod(t * 0.004 + aSeed, 1.0) * 0.06;

				// Is it inside the beam? Measure its distance from the beam's axis
				// and compare with the beam's radius at that point.
				vec3 d = p - uApex;
				float along = dot(d, uAxis);
				float radial = length(d - along * uAxis);
				float beamRadius = max(along * uTan, 1e-4);
				float inBeam = 1.0 - smoothstep(0.55 * beamRadius, beamRadius, radial);

				// Twinkle: a mote flashes when it turns its flat side to the light
				float twinkle = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(t * (0.6 + aSeed * 1.8) + aSeed * 90.0), 3.0);
				vLight = inBeam * twinkle;

				vec4 mv = modelViewMatrix * vec4(p, 1.0);
				gl_Position = projectionMatrix * mv;
				// Perspective size: nearer motes are bigger
				gl_PointSize = (2.0 + aSeed * 2.5) * uPixelRatio * (2.2 / -mv.z);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor;
			varying float vLight;
			void main() {
				// gl_PointCoord is 0..1 across the point's square: fade to a soft dot
				float r = length(gl_PointCoord - 0.5);
				float soft = smoothstep(0.5, 0.0, r);
				gl_FragColor = vec4(uColor * soft * vLight * 0.9, 1.0);
			}
		`,
	});
	const points = new Points(geometry, material);
	points.renderOrder = 11;
	points.frustumCulled = false; // positions move in the shader, so the CPU's bounds are stale
	return { points, material };
}

/* ---------- shader 3: the lens (vignette + film grain) ---------- */

const LensShader = {
	uniforms: {
		tDiffuse: { value: null as Texture | null }, // the finished frame, from the previous pass
		uTime: { value: 0 },
		uGrain: { value: 0.028 },
		uVignette: { value: 0.55 },
		uAspect: { value: 1 },
	},
	vertexShader: /* glsl */ `
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */ `
		uniform sampler2D tDiffuse;
		uniform float uTime;
		uniform float uGrain;
		uniform float uVignette;
		uniform float uAspect;
		varying vec2 vUv;

		// Cheap hash: turns a 2D coordinate into a pseudo-random 0..1 value
		float hash(vec2 p) {
			return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
		}

		void main() {
			vec4 color = texture2D(tDiffuse, vUv);

			// Vignette: darken toward the corners, as real lenses do. Distance is
			// corrected for aspect ratio so the falloff is round, not oval.
			vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
			float v = smoothstep(0.95, 0.2, length(c));
			color.rgb *= mix(1.0, v, uVignette);

			// Film grain: new noise every frame (uTime), strongest in the
			// mid-tones like real film, applied after tone mapping so it sits on
			// top of the picture instead of being squashed by it.
			float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
			float grain = hash(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5;
			color.rgb += grain * uGrain * (1.0 - abs(luma - 0.5) * 1.2);

			gl_FragColor = color;
		}
	`,
};

/* ---------- putting it together ---------- */

export type BookStage = {
	scene: Scene;
	fog: Fog;
	setSize(width: number, height: number): void;
	/** Advance shader time; `focusDistance` is the camera's distance to the book, for depth of field */
	render(time: number, focusDistance: number, reduced: boolean): void;
};

export function createBookStage(renderer: WebGLRenderer, camera: PerspectiveCamera, quality: Quality): BookStage {
	const scene = new Scene();
	scene.background = new Color(BACKGROUND);
	const fog = new Fog(BACKGROUND, 3.6, 8.5);
	scene.fog = fog;

	// 2. Image-based lighting: a pre-blurred environment for reflections, kept dim
	const pmrem = new PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
	scene.environmentIntensity = 0.1;
	pmrem.dispose();

	// 1. The lamp's light. Candela with inverse-square falloff (decay 2): the
	//    pool on the desk is bright at the centre and drops off naturally.
	const spot = new SpotLight(LAMP_LIGHT, 15, 0, BEAM_ANGLE, 0.8, 2);
	spot.position.copy(LAMP_HEAD).add(LAMP_TARGET.clone().sub(LAMP_HEAD).normalize().multiplyScalar(0.1));
	spot.target.position.copy(LAMP_TARGET);
	spot.castShadow = true;
	spot.shadow.mapSize.setScalar(quality === 'high' ? 2048 : 1024);
	spot.shadow.camera.near = 0.3;
	spot.shadow.camera.far = 4;
	spot.shadow.bias = -0.0003;
	spot.shadow.normalBias = 0.02;
	spot.shadow.radius = 5; // PCF blur: soft-edged shadows, like a real bulb's
	scene.add(spot, spot.target);
	// Cool "moonlight" from above and a warm bounce from the desk, both faint
	scene.add(new HemisphereLight('#7f8fb3', '#2a1a10', 0.12));

	// The desk, mat and props
	const walnut = makeWalnut();
	const desk = new Mesh(new PlaneGeometry(14, 14), new MeshStandardMaterial({ ...walnut, roughness: 1, metalness: 0 }));
	desk.rotation.x = -Math.PI / 2;
	desk.receiveShadow = true;
	const mat = new Mesh(new PlaneGeometry(3.6, 2.55), new MeshStandardMaterial({ map: makeMat(), roughness: 0.88 }));
	mat.rotation.set(-Math.PI / 2, 0, 0.04);
	mat.position.set(0.05, 0.0015, 0.05);
	mat.receiveShadow = true;
	scene.add(desk, mat, buildLamp(), buildCup(), ...buildPen(), buildTargets());

	const { beam, material: beamMaterial } = buildBeam();
	const { points: dust, material: dustMaterial } = buildDust(quality === 'high' ? 220 : 110);
	scene.add(beam, dust);

	// 6. Post-processing chain, all in half-float HDR until the OutputPass
	const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: quality === 'high' ? 4 : 2 });
	const composer = new EffectComposer(renderer, target);
	composer.addPass(new RenderPass(scene, camera));
	// Depth of field (desktop only: it renders the scene a second time for depth)
	const bokeh = quality === 'high' ? new BokehPass(scene, camera, { focus: 3, aperture: 0.0016, maxblur: 0.005 }) : null;
	if (bokeh) composer.addPass(bokeh);
	// Bloom: only pixels brighter than the threshold glow. In HDR, lit white
	// paper is around 1-2, so a threshold of 2.6 leaves the pages alone and
	// catches just the bulb (14) and the sharpest glints on foil and brass.
	const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.28, 0.5, 2.6);
	composer.addPass(bloom);
	composer.addPass(new OutputPass()); // tone mapping (AgX) + sRGB, from the renderer's settings
	const lens = new ShaderPass(LensShader);
	composer.addPass(lens);

	return {
		scene,
		fog,
		setSize(width, height) {
			composer.setPixelRatio(renderer.getPixelRatio());
			composer.setSize(width, height);
			lens.uniforms.uAspect.value = width / height;
			dustMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
		},
		render(time, focusDistance, reduced) {
			beamMaterial.uniforms.uTime.value = reduced ? 0 : time;
			dustMaterial.uniforms.uTime.value = time;
			dustMaterial.uniforms.uMotion.value = reduced ? 0 : 1;
			lens.uniforms.uTime.value = reduced ? 0 : time;
			if (bokeh) (bokeh.uniforms as Record<string, { value: number }>).focus.value = focusDistance;
			composer.render();
		},
	};
}

