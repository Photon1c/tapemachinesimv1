import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as dat from './node_modules/dat.gui/build/dat.gui.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const clock = new THREE.Clock();

let scene, camera, renderer, controls, drum, takeupRoller, needle;
let drumTraceCanvas, drumTraceContext, drumTexture;
let time = 0;
let lastTraceY;
const traceCanvasWidth = 512;
const traceCanvasHeight = 128;
let drumRotationSpeed = 0.0000001; // Extremely slow at startup
let needleAmplitude = 0.5;
let waveFrequency = 1.0;
let showGrid = true;
let clothStiffness = 0.8; // Increased stiffness
let activeClothMesh = null;
let isPaused = false;
let paperThickness = 0.05; // Added paper thickness parameter
let clothFeedOffset = 0;
let enclosure = null;
let collectionBox = null;

// --- UI: Add 3D Start Button to Control Traceline Animation ---
let tracelineEnabled = false;
let startButtonMesh = null;
let startButtonLabel = null;

function add3DStartButton() {
    // Remove previous button and label if they exist
    if (startButtonMesh) {
        scene.remove(startButtonMesh);
        startButtonMesh.geometry.dispose();
        startButtonMesh.material.dispose();
        startButtonMesh = null;
    }
    if (startButtonLabel) {
        scene.remove(startButtonLabel);
        if (startButtonLabel.material.map) startButtonLabel.material.map.dispose();
        startButtonLabel.material.dispose();
        startButtonLabel = null;
    }
    // Find the collection box
    const collectionBox = scene.getObjectByName('CollectionBox');
    if (!collectionBox) {
        console.warn('CollectionBox not found for button placement.');
        return;
    }
    // Get box height from geometry parameters
    const boxHeight = collectionBox.geometry.parameters.height;
    // Compute top center in world space
    const offset = 0.03; // Slightly above the top
    const topCenter = new THREE.Vector3(
        collectionBox.position.x,
        collectionBox.position.y + (boxHeight / 2) + offset,
        collectionBox.position.z
    );
    console.log('[DEBUG] 3D Start Button topCenter:', topCenter);
    // Add a visible axes helper at the button position for debugging
    const buttonAxes = new THREE.AxesHelper(0.2);
    buttonAxes.position.copy(topCenter);
    scene.add(buttonAxes);
    // Create the button mesh (larger blue disc)
    const buttonGeometry = new THREE.CylinderGeometry(0.25, 0.25, 0.06, 48);
    const buttonMaterial = new THREE.MeshStandardMaterial({ color: 0x2196f3, emissive: 0x1976d2, metalness: 0.5, roughness: 0.3 });
    startButtonMesh = new THREE.Mesh(buttonGeometry, buttonMaterial);
    startButtonMesh.name = 'StartButton3D';
    startButtonMesh.position.copy(topCenter);
    // Orient the button flat on the box (no rotation needed for disc face up)
    startButtonMesh.rotation.set(0, 0, 0);
    startButtonMesh.castShadow = true;
    startButtonMesh.receiveShadow = true;
    scene.add(startButtonMesh);
    // Add a label (larger, always above the button)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 128);
    ctx.font = 'bold 64px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'white';
    ctx.fillText('Start', 128, 64);
    const labelTexture = new THREE.CanvasTexture(canvas);
    const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, transparent: true });
    startButtonLabel = new THREE.Sprite(labelMaterial);
    startButtonLabel.position.copy(topCenter);
    startButtonLabel.position.y += 0.13; // Raise label above button
    startButtonLabel.scale.set(0.5, 0.2, 1); // Larger label
    // Ensure the label is upright (no rotation)
    startButtonLabel.material.rotation = 0;
    scene.add(startButtonLabel);
}

// Raycasting for 3D button interaction
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
window.addEventListener('pointerdown', (event) => {
    // Get normalized device coordinates
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    if (startButtonMesh) {
        const intersects = raycaster.intersectObject(startButtonMesh);
        if (intersects.length > 0) {
            tracelineEnabled = !tracelineEnabled;
            // Update button color and label
            startButtonMesh.material.color.set(tracelineEnabled ? 0x43a047 : 0x2196f3); // Green if running, blue if stopped
            startButtonMesh.material.emissive.set(tracelineEnabled ? 0x2e7d32 : 0x1976d2);
            // Update label
            const ctx = startButtonLabel.material.map.image.getContext('2d');
            ctx.clearRect(0, 0, 256, 128);
            ctx.fillStyle = 'white';
            ctx.font = 'bold 64px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(tracelineEnabled ? 'Stop' : 'Start', 128, 64);
            startButtonLabel.material.map.needsUpdate = true;
        }
    }
});

const CLOTH_CONFIG = {
    width: 8.0,            // Actual width of the paper strip itself
    height: 1,             // Placeholder, will be set after definition
    segments: 2,           // Minimal segments for a uniform strip
    segmentsY: 100,        // Placeholder, will be set after definition
    damping: 0.995,        // Very high damping for stability
    drag: 0.995,           // Very high drag for stability
    mass: 0.01,            // Very light for better response
    wind: 0.0,
    iterations: 12,        // Enough iterations for stability
    rollerRadius: 0.35,
    rollerSpacing: 3.5,
    feedRate: 0.00003,     // Much slower for smooth, calm movement
    pinRows: 1,            // Single pin row for simplicity
    collectionBoxSize: { width: 4.5, height: 1.0, depth: 2 },
    guideBarRadius: 0.1,
    guideBarOffset: 0.2,
    initialTension: 0.1,   // Low tension for smooth movement
    thickness: 0.02,       // Thin paper
    rotationDirection: 1,  // Clockwise rotation
    stiffness: 0.995,      // Very stiff to keep uniform shape
    bendStiffness: 0.995,  // Very stiff to prevent unwanted bending
    clipOffset: 0.01,      // Small offset for drum clipping planes
    beltThickness: 0.05,   // A small thickness for the belt mesh if we use ExtrudeGeometry later, or for visual cues
    drumWidth: 3.0,        // The "height" or thickness of the drum cylinders themselves
    yPosition: 4.0,       // Y-coordinate for the flat paper belt
};
// Set correct values after definition
CLOTH_CONFIG.height = 2 * (CLOTH_CONFIG.rollerSpacing + Math.PI * CLOTH_CONFIG.rollerRadius);
CLOTH_CONFIG.segmentsY = 100;

// Set smaller drum radius and default drum positions
CLOTH_CONFIG.rollerRadius = 0.35;
let leftDrumZ = -1.0;
let rightDrumZ = 1.0;

// Scale indicators
const scaleMarkers = {
    xAxis: null,
    yAxis: null,
    xLabels: [],
    yLabels: []
};

const defaultCameraPosition = { x: 3, y: 4, z: 5 };
const needleBaseZ_world = 1.55;

// Add a global for belt scroll speed
let beltScrollSpeed = 0.1; // units per second
let beltScrollTime = 0; // will be updated in the animation loop

// Parameters for the band
const NUM_LENGTH = 120; // Longer, more continuous band
const NUM_WIDTH = 16;   // Smoother, more cloth-like band
const BAND_WIDTH = 2.4; // Thicker band
const OVAL_RADIUS = 0.75;
const OVAL_CENTER_Z = 0;
const OVAL_CENTER_X = 0;
const OVAL_Y = 2.0;
const PERPETUAL_SPEED = 0.01; // Much slower perpetual motion for visible trace

// Calculate minimum drum distance for full band visibility
const minDrumDistance = 2 * CLOTH_CONFIG.rollerRadius + BAND_WIDTH + 0.1;
const maxDrumDistance = minDrumDistance + 1.0;
let defaultDrumDistance = minDrumDistance;

// Move the grey base up close to the drums, with a small gap
const baseYOffset = 1.0;

// --- Verlet Cloth System Integration ---
// 1. VerletParticle and VerletConstraint classes
class VerletParticle {
    constructor(position, isFixed = false) {
        this.position = position.clone();
        this.prevPosition = position.clone();
        this.isFixed = isFixed;
        this.acceleration = new THREE.Vector3();
    }
    addForce(force) {
        this.acceleration.add(force);
    }
    integrate(dt) {
        if (this.isFixed) return;
        const temp = this.position.clone();
        // Verlet integration
        this.position.add(this.position.clone().sub(this.prevPosition)).add(this.acceleration.multiplyScalar(dt * dt));
        this.prevPosition.copy(temp);
        this.acceleration.set(0, 0, 0);
    }
}
class VerletConstraint {
    constructor(p1, p2, restLength) {
        this.p1 = p1;
        this.p2 = p2;
        this.restLength = restLength;
    }
    satisfy() {
        const diff = this.p2.position.clone().sub(this.p1.position);
        const dist = diff.length();
        if (dist === 0) return;
        const correction = diff.multiplyScalar((dist - this.restLength) / dist / 2);
        if (!this.p1.isFixed) this.p1.position.add(correction);
        if (!this.p2.isFixed) this.p2.position.sub(correction);
    }
}

// --- Verlet Cloth Band System Integration ---
let verletParticles = [];
let verletConstraints = [];
let verletClothMesh = null;
let perpetualOffset = 0;

function ovalBandPosition(t, w) {
    // t in [0,1): position along the racetrack path (now in Y-Z plane)
    // w in [-0.5,0.5]: position across the width (X axis)
    // Uses leftDrumZ, rightDrumZ, DRUM_RADIUS, OVAL_Y
    const x = w * BAND_WIDTH; // width along X
    const r = CLOTH_CONFIG.rollerRadius;
    const z0 = leftDrumZ;
    const z1 = rightDrumZ;
    const y0 = OVAL_Y - r; // bottom of the oval
    const y1 = OVAL_Y + r; // top of the oval
    const straightLen = Math.abs(z1 - z0);
    const arcLen = Math.PI * r;
    const totalLen = 2 * straightLen + 2 * arcLen;
    const pStraight = straightLen / totalLen;
    const pArc = arcLen / totalLen;
    let py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    t = t % 1.0;
    if (t < pStraight) {
        // Front straight (z from z0 to z1, y = y0 - r)
        const lt = t / pStraight;
        py = y0;
        pz = z0 + (z1 - z0) * lt;
        nx = 0; ny = -1; nz = 0;
    } else if (t < pStraight + pArc) {
        // Right arc (center at z1, OVAL_Y)
        const lt = (t - pStraight) / pArc;
        const angle = Math.PI + lt * Math.PI; // PI to 2PI
        py = OVAL_Y + r * Math.sin(angle);
        pz = z1 + r * Math.cos(angle);
        nx = 0; ny = Math.sin(angle); nz = Math.cos(angle);
    } else if (t < 2 * pStraight + pArc) {
        // Back straight (z from z1 to z0, y = y1 + r)
        const lt = (t - (pStraight + pArc)) / pStraight;
        py = y1;
        pz = z1 - (z1 - z0) * lt;
        nx = 0; ny = 1; nz = 0;
    } else {
        // Left arc (center at z0, OVAL_Y)
        const lt = (t - (2 * pStraight + pArc)) / pArc;
        const angle = 0 + lt * Math.PI; // 0 to PI
        py = OVAL_Y + r * Math.sin(angle);
        pz = z0 + r * Math.cos(angle);
        nx = 0; ny = Math.sin(angle); nz = Math.cos(angle);
    }
    // Offset by width (outward normal is along X)
    return new THREE.Vector3(
        x,
        py,
        pz
    );
}

function initVerletCloth() {
    console.log('initVerletCloth called');
    verletParticles = [];
    verletConstraints = [];
    // Create grid of particles
    for (let i = 0; i < NUM_LENGTH; i++) {
        const t = i / NUM_LENGTH;
        for (let j = 0; j < NUM_WIDTH; j++) {
            const w = (j / (NUM_WIDTH - 1)) - 0.5; // -0.5 to 0.5
            // Pin a small cluster of points at the left and right drum contact regions
            let isFixed = false;
            // Left drum contact (bottom of oval)
            if ((i === 0 || i === 1 || i === 2) && (j === 0 || j === 1 || j === NUM_WIDTH-2 || j === NUM_WIDTH-1)) {
                isFixed = true;
            }
            // Right drum contact (top of oval)
            if ((i === Math.floor(NUM_LENGTH/2)-1 || i === Math.floor(NUM_LENGTH/2) || i === Math.floor(NUM_LENGTH/2)+1) && (j === 0 || j === 1 || j === NUM_WIDTH-2 || j === NUM_WIDTH-1)) {
                isFixed = true;
            }
            const pos = ovalBandPosition(t, w);
            verletParticles.push(new VerletParticle(pos, isFixed));
        }
    }
    // Connect neighbors (belt direction and width direction)
    for (let i = 0; i < NUM_LENGTH; i++) {
        for (let j = 0; j < NUM_WIDTH; j++) {
            const idx = i * NUM_WIDTH + j;
            // Next along belt (wraps around)
            const nextI = (i + 1) % NUM_LENGTH;
            const idxNext = nextI * NUM_WIDTH + j;
            verletConstraints.push(new VerletConstraint(
                verletParticles[idx], verletParticles[idxNext],
                verletParticles[idx].position.distanceTo(verletParticles[idxNext].position)
            ));
            // Next across width (no wrap)
            if (j < NUM_WIDTH - 1) {
                const idxW = i * NUM_WIDTH + (j + 1);
                verletConstraints.push(new VerletConstraint(
                    verletParticles[idx], verletParticles[idxW],
                    verletParticles[idx].position.distanceTo(verletParticles[idxW].position)
                ));
            }
        }
    }
    // Remove old mesh if exists
    if (verletClothMesh) {
        scene.remove(verletClothMesh);
        verletClothMesh.geometry.dispose();
        verletClothMesh.material.dispose();
    }
    // Create geometry for mesh (as a white band)
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(NUM_LENGTH * NUM_WIDTH * 3);
    const indices = [];
    // Triangles for the band
    for (let i = 0; i < NUM_LENGTH; i++) {
        for (let j = 0; j < NUM_WIDTH - 1; j++) {
            const i0 = i * NUM_WIDTH + j;
            const i1 = ((i + 1) % NUM_LENGTH) * NUM_WIDTH + j;
            const i2 = i * NUM_WIDTH + (j + 1);
            const i3 = ((i + 1) % NUM_LENGTH) * NUM_WIDTH + (j + 1);
            indices.push(i0, i1, i2);
            indices.push(i1, i3, i2);
        }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide, wireframe: false });
    verletClothMesh = new THREE.Mesh(geometry, material);
    scene.add(verletClothMesh);
    patchBeltMaterial();
}

function updateVerletCloth(dt) {
    // Perpetual motion: shift the band along the belt direction
    perpetualOffset = (perpetualOffset + PERPETUAL_SPEED * dt) % 1.0;
    // For each particle, set its position exactly on the racetrack/oval path
    for (let i = 0; i < NUM_LENGTH; i++) {
        const t = (i / NUM_LENGTH + perpetualOffset) % 1.0;
        for (let j = 0; j < NUM_WIDTH; j++) {
            const idx = i * NUM_WIDTH + j;
            const w = (j / (NUM_WIDTH - 1)) - 0.5;
            const target = ovalBandPosition(t, w);
            verletParticles[idx].position.copy(target);
            verletParticles[idx].prevPosition.copy(target);
        }
    }
    // Update mesh
    const posAttr = verletClothMesh.geometry.attributes.position;
    for (let i = 0; i < NUM_LENGTH * NUM_WIDTH; i++) {
        const p = verletParticles[i].position;
        posAttr.setXYZ(i, p.x, p.y, p.z);
    }
    posAttr.needsUpdate = true;
    verletClothMesh.geometry.computeVertexNormals();
}
// --- End Verlet Cloth Band System Integration ---

function init() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf0f0f0);

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(defaultCameraPosition.x, defaultCameraPosition.y, defaultCameraPosition.z);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    document.body.appendChild(renderer.domElement);

    // Lighting
    setupLighting();

    // OrbitControls
    setupControls();

    // Create Seismograph Geometry
    createSeismograph();

    // Setup drum trace texture
    setupDrumTrace();

    // Create scale indicators
    createScaleIndicators();

    // Setup GUI controls (dat.GUI)
    setupGUI();

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    // --- ENSURE VERLET CLOTH IS ACTIVE ---
    // After scene is created and before animation loop starts:
    loadCollectionBox();
    setupBeltTraceTexture();
    createSeismographTraceLine();
    animate();
}

function setupLighting() {
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    directionalLight.position.set(5, 10, 7.5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 50;
    directionalLight.shadow.bias = -0.0001;
    scene.add(directionalLight);

    const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
    backLight.position.set(-5, 5, -5);
    scene.add(backLight);
}

function setupControls() {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 2;
    controls.maxDistance = 20;
    controls.maxPolarAngle = Math.PI / 1.9;
    controls.target.set(0, 1, 0);
    controls.update();
}

function setupUIControls() {
    // Amplitude control
    const amplitudeSlider = document.getElementById('amplitude');
    amplitudeSlider.addEventListener('input', (e) => {
        needleAmplitude = parseFloat(e.target.value);
    });

    // Speed control
    const speedSlider = document.getElementById('speed');
    speedSlider.addEventListener('input', (e) => {
        drumRotationSpeed = parseFloat(e.target.value);
    });

    // Frequency control
    const frequencySlider = document.getElementById('frequency');
    frequencySlider.addEventListener('input', (e) => {
        waveFrequency = parseFloat(e.target.value);
    });

    // Reset camera button
    document.getElementById('resetCamera').addEventListener('click', () => {
        camera.position.set(defaultCameraPosition.x, defaultCameraPosition.y, defaultCameraPosition.z);
        controls.target.set(0, 1, 0);
        controls.update();
    });

    // Toggle grid button
    document.getElementById('toggleGrid').addEventListener('click', () => {
        showGrid = !showGrid;
        setupDrumTrace(); // Redraw the texture with or without grid
    });

    // Add cloth stiffness control
    const stiffnessSlider = document.getElementById('cloth-stiffness');
    stiffnessSlider.addEventListener('input', (e) => {
        clothStiffness = parseFloat(e.target.value);
        if (activeClothMesh && activeClothMesh.userData.physics) {
            activeClothMesh.userData.physics.STIFFNESS = clothStiffness;
        }
    });
}

function createScaleIndicators() {
    // Create X-axis (time) scale
    const xAxisGeo = new THREE.BufferGeometry();
    const xAxisPoints = [];
    for (let x = -1.5; x <= 1.5; x += 0.1) {
        xAxisPoints.push(x, 0.5, -1);
        xAxisPoints.push(x, 0.5, -0.9);
    }
    xAxisGeo.setAttribute('position', new THREE.Float32BufferAttribute(xAxisPoints, 3));
    scaleMarkers.xAxis = new THREE.LineSegments(
        xAxisGeo,
        new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    );
    scene.add(scaleMarkers.xAxis);

    // Create Y-axis (amplitude) scale
    const yAxisGeo = new THREE.BufferGeometry();
    const yAxisPoints = [];
    for (let y = 0.5; y <= 1.5; y += 0.1) {
        yAxisPoints.push(-1.5, y, -1);
        yAxisPoints.push(-1.4, y, -1);
    }
    yAxisGeo.setAttribute('position', new THREE.Float32BufferAttribute(yAxisPoints, 3));
    scaleMarkers.yAxis = new THREE.LineSegments(
        yAxisGeo,
        new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
    );
    scene.add(scaleMarkers.yAxis);

    // After creating scaleMarkers.xAxis and scaleMarkers.yAxis in createScaleIndicators():
    if (scaleMarkers.xAxis) scaleMarkers.xAxis.position.y += baseYOffset;
    if (scaleMarkers.yAxis) scaleMarkers.yAxis.position.y += baseYOffset;
}

function setupDrumTrace() {
    drumTraceCanvas = document.createElement('canvas');
    drumTraceCanvas.width = traceCanvasWidth;
    drumTraceCanvas.height = traceCanvasHeight;
    drumTraceContext = drumTraceCanvas.getContext('2d');

    // Clear canvas with paper color
    drumTraceContext.fillStyle = '#FFFEF0';
    drumTraceContext.fillRect(0, 0, traceCanvasWidth, traceCanvasHeight);

    if (showGrid) {
        // Draw grid lines
        drumTraceContext.strokeStyle = '#DDDDCC';
        drumTraceContext.lineWidth = 0.5;
        
        // Horizontal lines
        for (let i = 0; i < traceCanvasHeight; i += 10) {
            drumTraceContext.beginPath();
            drumTraceContext.moveTo(0, i + 0.5);
            drumTraceContext.lineTo(traceCanvasWidth, i + 0.5);
            drumTraceContext.stroke();
        }
        
        // Vertical lines
        for (let i = 0; i < traceCanvasWidth; i += 50) {
            drumTraceContext.beginPath();
            drumTraceContext.moveTo(i + 0.5, 0);
            drumTraceContext.lineTo(i + 0.5, traceCanvasHeight);
            drumTraceContext.stroke();
        }
    }

    // Create or update texture
    if (!drumTexture) {
        drumTexture = new THREE.CanvasTexture(drumTraceCanvas);
    } else {
        drumTexture.needsUpdate = true;
    }
    
    // Apply texture to drum material if it exists
    if (drum && drum.material) {
        drum.material.map = drumTexture;
        drum.material.needsUpdate = true;
    }

    lastTraceY = traceCanvasHeight / 2;
}

function createSeismograph() {
    console.log("[DEBUG] Initializing createSeismograph. Current scene children:");
    const childrenToRemove = [];
    scene.children.forEach(child => {
        console.log(`  - Child: name='${child.name}', type='${child.type}', uuid='${child.uuid}'`);
        if (child.name === "PaperClothTube" || child.name === "DebugPaperClothTube" || 
            child.name === "FlatPaperBelt" || child.name === "DebugFlatPaperBelt" ||
            (typeof drum !== 'undefined' && child === drum) || 
            (typeof takeupRoller !== 'undefined' && child === takeupRoller)) {
            childrenToRemove.push(child);
        }
    });
    childrenToRemove.forEach(child => {
        console.log("[DEBUG] Aggressively removing child:", child.name || child.uuid);
        scene.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
    });
    drum = undefined; // Ensure they are redefined
    takeupRoller = undefined;
    activeClothMesh = undefined;

    const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0.5, roughness: 0.6 });
    const supportMaterial = new THREE.MeshStandardMaterial({ color: 0x654321, metalness: 0.3, roughness: 0.7 });
    const guideBarMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff, wireframe: true }); // BRIGHT BLUE for DEBUG

    // Move the grey base up close to the drums, with a small gap
    const baseDepth = CLOTH_CONFIG.rollerSpacing + CLOTH_CONFIG.collectionBoxSize.depth + 0.2;
    const baseHeight = 0.5;
    const base = new THREE.Mesh(
        new THREE.BoxGeometry(3, baseHeight, baseDepth),
        baseMaterial
    );
    // Move both the base and collection box up by a small amount (0.15 units)
    base.position.y = 0.25 + baseYOffset;
    base.position.z = -0.5 * (CLOTH_CONFIG.collectionBoxSize.depth + 0.2); // unchanged
    base.castShadow = true;
    base.receiveShadow = true;
    base.name = 'GreyBase';
    scene.add(base);

    // Create collection box
    const boxMaterial = new THREE.MeshStandardMaterial({
        color: 0x8B4513,
        metalness: 0.3,
        roughness: 0.7,
        transparent: false,
        opacity: 1.0
    });

    const boxGeometry = new THREE.BoxGeometry(
        CLOTH_CONFIG.collectionBoxSize.width,
        CLOTH_CONFIG.collectionBoxSize.height,
        CLOTH_CONFIG.collectionBoxSize.depth
    );

    const collectionBox = new THREE.Mesh(boxGeometry, boxMaterial);
    collectionBox.name = 'CollectionBox';
    const boxZ = base.position.z + baseDepth / 2 + CLOTH_CONFIG.collectionBoxSize.depth / 2 + 0.01; // Tiny gap
    collectionBox.position.set(
        0,
        CLOTH_CONFIG.collectionBoxSize.height / 2 + baseYOffset,
        boxZ // Place exactly at the grey base edge
    );
    collectionBox.castShadow = true;
    collectionBox.receiveShadow = true;
    scene.add(collectionBox);

    // Add two thin black slits to the collection box (entry and exit for the belt)
    const slitWidth = 4.0 * 0.8; // Use original box width, not new band width
    const slitHeight = 0.04; // Thin slit
    const slitDepth = 0.01; // Very thin
    const boxFrontZ = boxZ - CLOTH_CONFIG.collectionBoxSize.depth / 2 + slitDepth / 2;
    const boxTopY = CLOTH_CONFIG.collectionBoxSize.height - slitHeight / 2 + baseYOffset;
    const boxBottomY = boxTopY - 0.08; // Move bottom slit closer to top slit

    const slitMaterial = new THREE.MeshStandardMaterial({ color: 0x111111 });

    // Top slit (belt entry)
    const topSlit = new THREE.Mesh(
        new THREE.BoxGeometry(slitWidth, slitHeight, slitDepth),
        slitMaterial
    );
    topSlit.position.set(0, boxTopY, boxFrontZ);
    scene.add(topSlit);

    // Bottom slit (belt exit)
    const bottomSlit = new THREE.Mesh(
        new THREE.BoxGeometry(slitWidth, slitHeight, slitDepth),
        slitMaterial
    );
    bottomSlit.position.set(0, boxBottomY, boxFrontZ);
    scene.add(bottomSlit);

    const postGeo = new THREE.CylinderGeometry(0.1, 0.1, 1.5, 16);
    
    // Create main drum (seismograph)
    const drumGeometry = new THREE.CylinderGeometry(CLOTH_CONFIG.rollerRadius, CLOTH_CONFIG.rollerRadius, CLOTH_CONFIG.drumWidth, 64);
    const drumStdMaterial = new THREE.MeshStandardMaterial({ // Renamed to avoid conflict if drum var was global from elsewhere
        color: 0x404040, metalness: 0.7, roughness: 0.3, map: drumTexture,
    });
    drum = new THREE.Mesh(drumGeometry, drumStdMaterial);
    drum.name = "MainDrum";
    drum.rotation.set(0, 0, Math.PI / 2);
    drum.position.set(0, 2, leftDrumZ);
    drum.castShadow = true;
    drum.receiveShadow = true;
    scene.add(drum);
    console.log("[DEBUG] MainDrum added to scene.");

    // Create take-up roller
    const takeupGeometry = new THREE.CylinderGeometry(CLOTH_CONFIG.rollerRadius, CLOTH_CONFIG.rollerRadius, CLOTH_CONFIG.drumWidth, 32);
    const takeupStdMaterial = new THREE.MeshStandardMaterial({ color: 0x404040, metalness: 0.7, roughness: 0.3 }); // Renamed
    takeupRoller = new THREE.Mesh(takeupGeometry, takeupStdMaterial);
    takeupRoller.name = "TakeupRoller";
    takeupRoller.rotation.set(0, 0, Math.PI / 2);
    takeupRoller.position.set(0, 2, rightDrumZ);
    takeupRoller.castShadow = true;
    takeupRoller.receiveShadow = true;
    scene.add(takeupRoller);
    console.log("[DEBUG] TakeupRoller added to scene.");

    // Remove old needle creation block
    createNeedleAndHook();

    // --- REMOVED: Guide bars, guide bar supports, and any debug/reference rods ---
    // --- Only essential geometry remains. ---

    // Add the 3D start button after the collection box is created
    add3DStartButton();
}

function generateSeismicWave(t) {
    // More realistic seismic wave pattern
    const mainShock = Math.sin(t * waveFrequency);
    const aftershock = 0.3 * Math.sin(t * waveFrequency * 2.5 + 1.0) * Math.exp(-t * 0.1);
    const noise = 0.1 * (Math.random() - 0.5);
    
    return needleAmplitude * (mainShock + aftershock + noise);
}

function updateDrumTrace(seismicDisplacement) {
    const advanceX = (drumRotationSpeed / (2 * Math.PI)) * traceCanvasWidth;

    // Calculate new Y position with improved scaling
    const currentTraceY = (traceCanvasHeight / 2) - (seismicDisplacement / needleAmplitude) * (traceCanvasHeight * 0.40);

    // Shift existing trace
    const imageData = drumTraceContext.getImageData(advanceX, 0, traceCanvasWidth - advanceX, traceCanvasHeight);
    drumTraceContext.putImageData(imageData, 0, 0);

    // Clear new area
    drumTraceContext.fillStyle = '#FFFEF0';
    drumTraceContext.fillRect(traceCanvasWidth - advanceX, 0, advanceX, traceCanvasHeight);
    
    // Draw grid if enabled
    if (showGrid) {
        drumTraceContext.strokeStyle = '#DDDDCC';
        drumTraceContext.lineWidth = 0.5;
        
        // Horizontal lines
        for (let i = 0; i < traceCanvasHeight; i += 10) {
            drumTraceContext.beginPath();
            drumTraceContext.moveTo(traceCanvasWidth - advanceX, i + 0.5);
            drumTraceContext.lineTo(traceCanvasWidth, i + 0.5);
            drumTraceContext.stroke();
        }
        
        // Vertical lines (time markers)
        const timeGridSpacing = 50;
        const startX = traceCanvasWidth - advanceX;
        const endX = traceCanvasWidth;
        const firstGridLine = Math.ceil(startX / timeGridSpacing) * timeGridSpacing;
        
        for (let x = firstGridLine; x <= endX; x += timeGridSpacing) {
            drumTraceContext.beginPath();
            drumTraceCtx.moveTo(x + 0.5, 0);
            drumTraceCtx.lineTo(x + 0.5, traceCanvasHeight);
            drumTraceCtx.stroke();
        }
    }

    // Draw trace line with anti-aliasing
    drumTraceContext.beginPath();
    drumTraceContext.strokeStyle = 'black';
    drumTraceContext.lineWidth = 1.5;
    drumTraceContext.lineCap = 'round';
    drumTraceContext.lineJoin = 'round';
    
    // Smooth line drawing
    const steps = Math.ceil(advanceX);
    for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const x = traceCanvasWidth - advanceX + (advanceX * t);
        const y = lastTraceY * (1 - t) + currentTraceY * t;
        
        if (i === 0) {
            drumTraceContext.moveTo(x, y);
        } else {
            drumTraceContext.lineTo(x, y);
        }
    }
    
    drumTraceContext.stroke();

    lastTraceY = currentTraceY;
    drumTexture.needsUpdate = true;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    updateVerletCloth(dt);
    updateBeltTraceTexture(dt);
    updateSeismographTraceLine(dt);
    // Spin the drums if they exist
    if (typeof drum !== 'undefined' && drum) {
        drum.rotation.x += 0.03;
    }
    if (typeof takeupRoller !== 'undefined' && takeupRoller) {
        takeupRoller.rotation.x += 0.03;
    }
    
    // Debug: Log scene objects periodically (every 5 seconds)
    if (Math.floor(performance.now() / 5000) > (window.lastLogTime || 0)) {
        window.lastLogTime = Math.floor(performance.now() / 5000);
        console.log('🎬 Current scene objects:');
        scene.children.forEach((child, index) => {
            console.log(`  ${index}: ${child.name || 'unnamed'} (${child.type}) at (${child.position.x.toFixed(1)}, ${child.position.y.toFixed(1)}, ${child.position.z.toFixed(1)})`);
        });
        if (needle) {
            console.log(`🎯 Needle visibility: ${needle.visible}, position: (${needle.position.x.toFixed(2)}, ${needle.position.y.toFixed(2)}, ${needle.position.z.toFixed(2)})`);
        }
    }
    
    renderer.render(scene, camera);
}

function setupGUI() {
    const gui = new dat.GUI();
    const params = {
        amplitude: needleAmplitude,
        frequency: waveFrequency,
        speed: drumRotationSpeed,
        paperThickness: paperThickness,
        stiffness: clothStiffness,
        tension: CLOTH_CONFIG.initialTension,
        proximity: CLOTH_CONFIG.rollerSpacing,
        quality: 'medium',
        pause: false,
        reset: () => resetSimulation(),
        drumDistance: defaultDrumDistance
    };

    // Performance presets
    const qualitySettings = {
        low: { segments: 60, segmentsY: 80, iterations: 10 },
        medium: { segments: 80, segmentsY: 100, iterations: 15 },
        high: { segments: 100, segmentsY: 120, iterations: 20 }
    };

    const seismicFolder = gui.addFolder('Seismic Controls');
    seismicFolder.add(params, 'amplitude', 0.1, 2.0, 0.1)
        .onChange(value => { needleAmplitude = value; });
    seismicFolder.add(params, 'frequency', 0.1, 5.0, 0.1)
        .onChange(value => { waveFrequency = value; });

    const paperFolder = gui.addFolder('Paper Controls');
    // Drum speed slider (wider, finer range)
    paperFolder.add(params, 'speed', 0.0000001, 0.00005, 0.0000001)
        .name('Drum Speed')
        .onChange(value => {
            drumRotationSpeed = value;
        });
    // Drum proximity slider
    paperFolder.add(params, 'proximity', 2.0, 6.0, 0.05)
        .name('Drum Proximity')
        .onChange(value => {
            CLOTH_CONFIG.rollerSpacing = value;
            // Update drum positions
            const leftDrumZ = -CLOTH_CONFIG.rollerSpacing / 2;
            const rightDrumZ = CLOTH_CONFIG.rollerSpacing / 2;
            drum.position.set(0, 2, leftDrumZ);
            takeupRoller.position.set(0, 2, rightDrumZ);
            // Regenerate the cloth loop
            // setupPaperFeed();
        });
    // Paper thickness control
    paperFolder.add(params, 'paperThickness', 0.01, 0.1, 0.01)
        .onChange(value => {
            paperThickness = value;
            if (activeClothMesh && activeClothMesh.userData.physics) {
                activeClothMesh.userData.physics.thickness = value;
            }
        });
    paperFolder.add(params, 'stiffness', 0.1, 1.0, 0.01)
        .onChange(value => { clothStiffness = value; });
    paperFolder.add(params, 'tension', 0.01, 1.0, 0.01)
        .onChange(value => { CLOTH_CONFIG.initialTension = value; });
    paperFolder.add(params, 'pause').onChange(value => { isPaused = value; });
    paperFolder.add(params, 'reset');

    // Drum distance control
    const drumDistanceController = gui.add(params, 'drumDistance', minDrumDistance, maxDrumDistance, 0.01).name('Drum Distance');
    drumDistanceController.onChange(function(value) {
        // Update drum positions and re-initialize cloth
        const center = (leftDrumZ + rightDrumZ) / 2;
        leftDrumZ = center - value / 2;
        rightDrumZ = center + value / 2;
        initVerletCloth();
    });

    // Default values
    let drumDistance = 2.8; // Longer by default
    let bandWidth = 1.5;
    let bandLength = 180; // NUM_LENGTH, more elongated
    CLOTH_CONFIG.rollerRadius = 0.35;

    // Ensure GUI properties exist on window for dat.GUI
    window.drumDistance = drumDistance;
    window.bandWidth = bandWidth;
    window.bandLength = bandLength;
    window.drumRadius = 0.35;

    // Remove any previous GUI setup for drum distance, band width, etc.
    if (typeof gui !== 'undefined') {
        gui.destroy();
    }

    // Ensure GUI is attached to the DOM
    if (!document.body.contains(gui.domElement)) {
        document.body.appendChild(gui.domElement);
    }

    const conveyorFolder = gui.addFolder('Conveyor');
    conveyorFolder.add(window, 'drumDistance', 1.5, 3.5, 0.01).name('Drum Distance').onChange(function(value) {
        leftDrumZ = -value / 2;
        rightDrumZ = value / 2;
        initVerletCloth();
    });
    conveyorFolder.add(window, 'drumRadius', 0.2, 1.0, 0.01).name('Drum Radius').onChange(function(value) {
        CLOTH_CONFIG.rollerRadius = value;
        initVerletCloth();
    });
    conveyorFolder.add(window, 'bandWidth', 0.5, 2.5, 0.01).name('Band Width').onChange(function(value) {
        window.BAND_WIDTH = value;
        initVerletCloth();
    });
    conveyorFolder.add(window, 'bandLength', 60, 240, 1).name('Band Length').onChange(function(value) {
        window.NUM_LENGTH = Math.floor(value);
        initVerletCloth();
    });
    conveyorFolder.open();

    leftDrumZ = -drumDistance / 2;
    rightDrumZ = drumDistance / 2;
    window.BAND_WIDTH = bandWidth;
    window.NUM_LENGTH = bandLength;
    initVerletCloth();

    // --- Scene Cleanup ---
    // Remove any floating tiny rods or unused objects from the scene
    scene.traverse(function(obj) {
        if (obj.name && obj.name.toLowerCase().includes('rod')) {
            scene.remove(obj);
        }
        // Optionally, remove other unused objects by name or type
    });
}

function resetSimulation() {
    if (activeClothMesh && activeClothMesh.userData.physics) {
        const physics = activeClothMesh.userData.physics;
        physics.offset = 0;
        physics.time = 0;
        physics.lastRowY = 0;
        
        // Reset all particles to their initial positions
        for (let i = 0; i < physics.particles.length; i++) {
            const particle = physics.particles[i];
            particle.position.copy(particle.original);
            particle.previous.copy(particle.original);
        }
        
        // Reset physics parameters
        physics.feedRate = CLOTH_CONFIG.feedRate;
        physics.DAMPING = CLOTH_CONFIG.damping;
        physics.DRAG = CLOTH_CONFIG.drag;
        physics.MASS = CLOTH_CONFIG.mass;
        physics.WIND = CLOTH_CONFIG.wind;
        physics.initialTension = CLOTH_CONFIG.initialTension;
    }
}

// TEMPORARY ovalClothPosition FOR DEBUGGING - SIMPLE CIRCLE
function ovalClothPosition(t, zLeft, zRight, radius) {
    const yLevel = CLOTH_CONFIG.yPosition;
    const angle = t * 2 * Math.PI;
    const centerZ = (zLeft + zRight) / 2;
    const px = radius * Math.cos(angle);
    const pz = centerZ + radius * Math.sin(angle);
    return new THREE.Vector3(px, yLevel, pz);
}

function loadCollectionBox() {
    const loader = new GLTFLoader();
    loader.load('textures/collection_box.glb', function(gltf) {
        collectionBox = gltf.scene;
        collectionBox.name = 'CollectionBox';
        // Position the box at the end of the conveyor (adjust Z as needed)
        // Assume right drum is at rightDrumZ, band is in Y-Z plane, so place box just after right drum
        const boxOffset = 0.45; // Adjust as needed for visual fit
        collectionBox.position.set(0, 0, rightDrumZ + CLOTH_CONFIG.rollerRadius + boxOffset);
        scene.add(collectionBox);
    }, undefined, function(error) {
        console.error('Error loading collection box:', error);
    });
}

// Move the conveyor belt system down so the top of the belt aligns with the top slit of the collection box
CLOTH_CONFIG.yPosition = CLOTH_CONFIG.collectionBoxSize.height;

// --- Dynamic Seismograph Trace on Belt ---
let beltTraceCanvas, beltTraceCtx, beltTraceTexture;
let beltTraceScroll = 0;

function setupBeltTraceTexture() {
    // Create a canvas for the belt trace
    beltTraceCanvas = document.createElement('canvas');
    beltTraceCanvas.width = 1024;
    beltTraceCanvas.height = 128;
    beltTraceCtx = beltTraceCanvas.getContext('2d');
    beltTraceTexture = new THREE.CanvasTexture(beltTraceCanvas);
    beltTraceTexture.wrapS = THREE.RepeatWrapping;
    beltTraceTexture.wrapT = THREE.ClampToEdgeWrapping;
    beltTraceTexture.repeat.set(1, 1);
    beltTraceTexture.needsUpdate = true;
}

function updateBeltTraceTexture(dt) {
    // Scroll the trace to the left as the belt moves
    const scrollSpeed = 200 * dt; // pixels per second, adjust for realism
    beltTraceScroll = (beltTraceScroll + scrollSpeed) % beltTraceCanvas.width;

    // Shift the canvas left
    const imageData = beltTraceCtx.getImageData(scrollSpeed, 0, beltTraceCanvas.width - scrollSpeed, beltTraceCanvas.height);
    beltTraceCtx.fillStyle = '#e0e0e0'; // Slightly darker gray for better contrast
    beltTraceCtx.fillRect(0, 0, beltTraceCanvas.width, beltTraceCanvas.height);
    beltTraceCtx.putImageData(imageData, 0, 0);

    // Draw new spikes at the right edge
    const centerY = beltTraceCanvas.height / 2;
    const amplitude = beltTraceCanvas.height * 0.35;
    const spikeWidth = 2;
    const x = beltTraceCanvas.width - scrollSpeed;
    // Simulate EEG/seismograph spikes (random + sine)
    for (let i = 0; i < scrollSpeed; i++) {
        const t = (performance.now() / 300 + i / 20) % (2 * Math.PI);
        // Random spikes
        let spike = Math.random() > 0.98 ? (Math.random() - 0.5) * amplitude * 2 : 0;
        // Sine wave base
        spike += Math.sin(t) * amplitude * 0.3;
        // Occasional big spike
        if (Math.random() > 0.995) spike += (Math.random() > 0.5 ? 1 : -1) * amplitude * 0.8;
        beltTraceCtx.strokeStyle = '#000000'; // Pure black traceline
        beltTraceCtx.lineWidth = 10; // Thick trace for visibility
        beltTraceCtx.beginPath();
        beltTraceCtx.moveTo(x + i, centerY);
        beltTraceCtx.lineTo(x + i, centerY - spike);
        beltTraceCtx.stroke();
    }
    beltTraceTexture.needsUpdate = true;
}

// Patch verletClothMesh material to use the dynamic texture
function patchBeltMaterial() {
    if (!beltTraceTexture) return;
    if (verletClothMesh) {
        verletClothMesh.material.map = beltTraceTexture;
        verletClothMesh.material.color.set(0xffffff); // Pure white, so texture is not washed out
        verletClothMesh.material.needsUpdate = true;
    }
}

// --- Seismograph Traceline as 3D Line ---
let traceLine, traceLineGeometry;
const TRACE_POINTS = 200;
let traceData = new Array(TRACE_POINTS).fill(0);

function createSeismographTraceLine() {
    // Remove old line if exists
    if (traceLine) scene.remove(traceLine);
    traceLineGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(TRACE_POINTS * 3);
    traceLineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 4 });
    traceLine = new THREE.Line(traceLineGeometry, material);
    traceLine.frustumCulled = false;
    scene.add(traceLine);
}

function updateSeismographTraceLine(dt) {
    if (!tracelineEnabled) return;
    // Shift trace data left, add new value at the end
    for (let i = 0; i < TRACE_POINTS - 1; i++) {
        traceData[i] = traceData[i + 1];
    }
    // Generate new value: sine + random spikes
    const tnow = performance.now() / 500;
    let value = Math.sin(tnow * 2) * 0.15; // Sine base
    if (Math.random() > 0.97) value += (Math.random() - 0.5) * 0.7; // Random spike
    if (Math.random() > 0.995) value += (Math.random() > 0.5 ? 1 : -1) * 1.2; // Rare big spike
    traceData[TRACE_POINTS - 1] = value;

    // Reverse the direction: Z runs from leftDrumZ to rightDrumZ
    const z0 = leftDrumZ;
    const z1 = rightDrumZ;
    const r = CLOTH_CONFIG.rollerRadius;
    const y = (OVAL_Y + r); // Y position of the TOP surface of the front straight

    const positions = traceLineGeometry.attributes.position.array;
    for (let i = 0; i < TRACE_POINTS; i++) {
        // Z runs from leftDrumZ to rightDrumZ
        const z = z0 + (i / (TRACE_POINTS - 1)) * (z1 - z0);
        positions[i * 3 + 0] = traceData[i]; // X modulated by trace
        positions[i * 3 + 1] = y; // Y = top surface
        positions[i * 3 + 2] = z;
    }
    traceLineGeometry.attributes.position.needsUpdate = true;
}

// --- Load precision needle assembly from Blender GLB ---
function createNeedleAndHook() {
    // Remove old needle and hook if they exist
    if (needle) scene.remove(needle);
    if (scene.getObjectByName('NeedleHook')) scene.remove(scene.getObjectByName('NeedleHook'));
    if (scene.getObjectByName('NeedleAssembly')) scene.remove(scene.getObjectByName('NeedleAssembly'));

    // Load the precision needle assembly from Blender
    const loader = new GLTFLoader();
    console.log('🔄 Starting to load needle.glb...');
    
    loader.load('textures/needle.glb', function(gltf) {
        console.log('🎯 GLB file loaded successfully:', gltf);
        needle = gltf.scene;
        needle.name = 'NeedleAssembly';
        
        // Debug: Log the loaded scene structure
        console.log('📦 Loaded scene children:', needle.children.length);
        needle.traverse(function(child) {
            console.log(`  - ${child.name || 'unnamed'}: ${child.type}`);
            if (child.isMesh) {
                console.log(`    Geometry: ${child.geometry.attributes.position.count} vertices`);
                console.log(`    Material: ${child.material.name || 'unnamed material'}`);
            }
        });
        
        // Calculate positioning to meet requirements:
        // 1. Start from opposite edge of grey base
        // 2. Be raised to proper height
        // 3. Make contact where belt meets top slit
        
        // Belt position calculations
        const beltY = (OVAL_Y + CLOTH_CONFIG.rollerRadius); // Top surface of belt
        
        // Calculate the Z position where the belt meets the top slit (contact point)
        const boxOffset = 0.45;
        const beltContactZ = rightDrumZ + CLOTH_CONFIG.rollerRadius + boxOffset - CLOTH_CONFIG.collectionBoxSize.depth / 2;
        
        console.log('📍 Positioning calculations:');
        console.log(`  OVAL_Y: ${OVAL_Y}`);
        console.log(`  rollerRadius: ${CLOTH_CONFIG.rollerRadius}`);
        console.log(`  beltY: ${beltY}`);
        console.log(`  rightDrumZ: ${rightDrumZ}`);
        console.log(`  leftDrumZ: ${leftDrumZ}`);
        console.log(`  contactZ: ${beltContactZ}`);
        
        // Get grey base dimensions and position (must match createSeismograph)
        const baseDepth = CLOTH_CONFIG.rollerSpacing + CLOTH_CONFIG.collectionBoxSize.depth + 0.2;
        const baseHeight = 0.5;
        const baseY = 0.25 + baseYOffset;
        const baseZ = -0.5 * (CLOTH_CONFIG.collectionBoxSize.depth + 0.2);

        console.log('--- Needle Alignment Debug ---');

        // 1. Find the NeedleBaseMarker in the loaded GLB
        let baseMarker = null;
        needle.traverse(obj => {
            if (obj.name === 'NeedleBaseMarker') baseMarker = obj;
        });
        if (!baseMarker) {
            console.error('NeedleBaseMarker not found in GLB!');
        } else {
            console.log('Found NeedleBaseMarker:', baseMarker);

            // 2. Get the anchor position (yellow sphere position, i.e., top near edge of grey base)
            const greyBase = scene.getObjectByName('GreyBase');
            greyBase.geometry.computeBoundingBox();
            greyBase.updateMatrixWorld();
            const bbox = greyBase.geometry.boundingBox;

            // Debug bounding box and world position
            console.log('GreyBase bounding box:', bbox);
            console.log('GreyBase world position:', greyBase.getWorldPosition(new THREE.Vector3()));

            // Try both max.y and min.y for anchor Y
            const anchorPosMaxY = new THREE.Vector3(0, bbox.max.y, bbox.min.z).applyMatrix4(greyBase.matrixWorld);
            const anchorPosMinY = new THREE.Vector3(0, bbox.min.y, bbox.min.z).applyMatrix4(greyBase.matrixWorld);

            console.log('Anchor (maxY):', anchorPosMaxY);
            console.log('Anchor (minY):', anchorPosMinY);

            // Use whichever is higher in Y for the magenta sphere
            const anchorPos = anchorPosMaxY.y > anchorPosMinY.y ? anchorPosMaxY : anchorPosMinY;

            const anchorDebug = new THREE.Mesh(
                new THREE.SphereGeometry(0.08, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0xff00ff })
            );
            anchorDebug.position.copy(anchorPos);
            scene.add(anchorDebug);

            // --- Needle flattening and lowering parameters ---
            // flattenAmount: 0 = original, 1 = fully horizontal (beltY)
            // lowerArmOffset: amount to lower the anchor (in world Y units)
            const flattenAmount = 0.5; // Try 0.3-0.7 for more/less flattening
            const lowerArmOffset = 0.2; // Try 0.1-0.3 for more/less lowering

            // Lower the anchor position
            const loweredAnchorPos = anchorPos.clone();
            loweredAnchorPos.y -= lowerArmOffset;

            // Interpolate target Y for flattening
            const flatTargetY = THREE.MathUtils.lerp(loweredAnchorPos.y, beltY, flattenAmount);
            const flatTargetPoint = new THREE.Vector3(0, flatTargetY, beltContactZ);

            // 3. Reset needle transform
            needle.position.set(0, 0, 0);
            needle.rotation.set(0, 0, 0);
            needle.scale.set(1, 1, 1);
            needle.updateMatrixWorld(true);

            // --- Patch: Align needle base orientation to grey base ---
            // Get grey base's world quaternion (orientation)
            const greyBaseQuat = new THREE.Quaternion();
            greyBase.getWorldQuaternion(greyBaseQuat);
            // Set needle's quaternion to match the base
            needle.quaternion.copy(greyBaseQuat);
            needle.updateMatrixWorld(true);

            // 4. Rotate the needle to face the (flattened) target point, but only around the base's up axis
            // Compute the direction from anchor to target
            const flatDirection = new THREE.Vector3().subVectors(flatTargetPoint, loweredAnchorPos).normalize();
            // Get the up axis of the base (Y axis in world space)
            const baseUp = new THREE.Vector3(0, 1, 0).applyQuaternion(greyBaseQuat);
            // Project the direction onto the plane perpendicular to baseUp
            const projectedDir = flatDirection.clone().projectOnPlane(baseUp).normalize();
            // Find the current forward direction of the needle (Blender +X in local space, transformed by base orientation)
            const needleForward = new THREE.Vector3(1, 0, 0).applyQuaternion(greyBaseQuat);
            // Compute the rotation needed around baseUp to align needleForward to projectedDir
            const angle = needleForward.angleTo(projectedDir);
            const axis = baseUp;
            const cross = new THREE.Vector3().crossVectors(needleForward, projectedDir);
            const sign = cross.dot(baseUp) < 0 ? -1 : 1;
            needle.rotateOnWorldAxis(axis, sign * angle);
            needle.updateMatrixWorld(true);

            // 5. Apply upright flip if needed
            needle.rotateX(Math.PI);
            needle.rotateZ(Math.PI);
            needle.updateMatrixWorld(true);

            // 6. (Optional) Scale as before
            const distance = loweredAnchorPos.distanceTo(flatTargetPoint);
            const requiredScale = Math.max(2.0, distance / 1.5);
            needle.scale.setScalar(requiredScale);
            needle.updateMatrixWorld(true);

            // 7. Now get the marker's world position (after rotation and scale)
            baseMarker.updateMatrixWorld(true);
            const markerPos = new THREE.Vector3();
            baseMarker.getWorldPosition(markerPos);
            console.log('NeedleBaseMarker world position BEFORE move:', markerPos);

            // Visual debug: cyan sphere at marker
            const markerDebug = new THREE.Mesh(
                new THREE.SphereGeometry(0.06, 16, 16),
                new THREE.MeshBasicMaterial({ color: 0x00ffff })
            );
            markerDebug.position.copy(markerPos);
            scene.add(markerDebug);

            // 8. Move the needle so the marker aligns with the (lowered) anchor
            const offset = new THREE.Vector3().subVectors(loweredAnchorPos, markerPos);
            needle.position.add(offset);
            needle.updateMatrixWorld(true);

            // Log for verification
            baseMarker.updateMatrixWorld(true);
            const markerPosAfter = new THREE.Vector3();
            baseMarker.getWorldPosition(markerPosAfter);
            console.log('NeedleBaseMarker world position AFTER move:', markerPosAfter);
            console.log('Anchor position (grey base near edge, lowered):', loweredAnchorPos);
            console.log('Needle position after alignment:', needle.position);
            console.log('Needle should now be flattened and lowered.');

            // --- Debug: Add AxesHelper to needle and grey base ---
            const needleAxes = new THREE.AxesHelper(0.2);
            needle.add(needleAxes);
            if (greyBase) {
                const baseAxes = new THREE.AxesHelper(0.2);
                greyBase.add(baseAxes);
            }

            // Log world orientation (quaternion) and position for both
            const needleWorldQuat = new THREE.Quaternion();
            needle.getWorldQuaternion(needleWorldQuat);
            console.log('Needle world quaternion:', needleWorldQuat);
            const greyBaseWorldQuat = new THREE.Quaternion();
            if (greyBase) {
                greyBase.getWorldQuaternion(greyBaseWorldQuat);
                console.log('GreyBase world quaternion:', greyBaseWorldQuat);
                console.log('GreyBase world position:', greyBase.getWorldPosition(new THREE.Vector3()));
            }
            console.log('Needle world position:', needle.getWorldPosition(new THREE.Vector3()));
        }

        // Remove origin and magenta box helpers for clarity (keep yellow sphere for now)
        scene.children = scene.children.filter(obj => obj.material?.color?.getHex() !== 0x00ff00 && obj.type !== 'Box3Helper');
        
        console.log('✅ Precision needle assembly loaded and positioned');
        console.log(`📍 Needle base (grey base center edge): X=${needle.position.x.toFixed(2)}, Y=${needle.position.y.toFixed(2)}, Z=${needle.position.z.toFixed(2)}`);
        console.log(`📏 Needle scale: ${needle.scale.x.toFixed(2)}`);
        console.log(`🎯 Belt contact target: X=0, Y=${beltY.toFixed(2)}, Z=${beltContactZ.toFixed(2)}`);
        console.log(`📐 Needle base edge: Z=${needle.position.z.toFixed(2)}, Y=${needle.position.y.toFixed(2)}`);
        //console.log(`📏 Distance from base to contact: ${distance.toFixed(2)} units`);
        //console.log(`🔄 Rotation direction vector: X=${direction.x.toFixed(3)}, Y=${direction.y.toFixed(3)}, Z=${direction.z.toFixed(3)}`);
        console.log(`✅ Needle should now be OPPOSITE to collection box!`);
        
        // Debug: Add a large yellow sphere at the intended base position
        const debugMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.2, 32, 32),
            new THREE.MeshBasicMaterial({ color: 0xffff00 })
        );
        debugMarker.position.set(0, needle.position.y, needle.position.z);
        scene.add(debugMarker);
        console.log('🟡 Debug marker position:', debugMarker.position);

        // Add a marker at the world origin for reference
        const originMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0x00ff00 })
        );
        originMarker.position.set(0, 0, 0);
        scene.add(originMarker);
        console.log('🟢 Origin marker at (0,0,0)');

        // Log all scene objects and their positions
        console.log('🔎 Scene objects and positions:');
        scene.children.forEach(obj => {
            console.log(`- ${obj.name || obj.type}: (${obj.position.x.toFixed(2)}, ${obj.position.y.toFixed(2)}, ${obj.position.z.toFixed(2)})`);
        });
        
        // Draw the bounding box of the grey base for visual debugging
        //const bboxWorld = bbox.clone().applyMatrix4(greyBase.matrixWorld);
        //const helper = new THREE.Box3Helper(bboxWorld, 0xff00ff);
        //scene.add(helper);

        //console.log('Grey base matrixWorld:', greyBase.matrixWorld);
        //console.log('Grey base geometry bounding box:', bbox);
        //console.log('Grey base world position:', greyBase.getWorldPosition(new THREE.Vector3()));
        
        scene.add(needle);
        console.log('🎬 Needle added to scene. Current scene children:', scene.children.length);
    });
}

// Fallback needle creation in case GLB loading fails
function createFallbackNeedle() {
    const needleLength = 0.5;
    const needleRadius = 0.015;
    const tipLength = 0.08;
    const needleGeometry = new THREE.CylinderGeometry(needleRadius, needleRadius, needleLength - tipLength, 16);
    const tipGeometry = new THREE.ConeGeometry(needleRadius * 1.2, tipLength, 16);
    const needleMaterial = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.3 });
    const tipMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.2 });
    const needleBody = new THREE.Mesh(needleGeometry, needleMaterial);
    const needleTip = new THREE.Mesh(tipGeometry, tipMaterial);
    needleTip.position.y = -(needleLength - tipLength) / 2 - tipLength / 2;
    needleBody.add(needleTip);
    needle = needleBody;
    needle.name = 'FallbackNeedle';

    // Position fallback needle
    const boxZ = -0.5 * (CLOTH_CONFIG.collectionBoxSize.depth + 0.2) + CLOTH_CONFIG.collectionBoxSize.depth + 0.01 + CLOTH_CONFIG.collectionBoxSize.depth / 2;
    const slitZ = boxZ - CLOTH_CONFIG.collectionBoxSize.depth / 2 + 0.01 / 2;
    const beltY = (OVAL_Y + CLOTH_CONFIG.rollerRadius);
    const boxTopY = CLOTH_CONFIG.collectionBoxSize.height + baseYOffset;

    needle.position.set(0, boxTopY - needleLength / 2 + tipLength / 2, slitZ);
    needle.rotation.x = Math.PI / 2;
    scene.add(needle);
}

init();

