import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { MultiplayerManager } from './multiplayer';

interface DeviceOrientationEventWithPermission extends DeviceOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const startOverlay = document.getElementById('start-overlay') as HTMLDivElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let physicsWorld: RAPIER.World;
let multiplayerManager: MultiplayerManager;

const physicsPairs: { mesh: THREE.Mesh | THREE.Group; body: RAPIER.RigidBody }[] = [];
interface Projectile { mesh: THREE.Mesh; body: RAPIER.RigidBody; spawnTime: number; shouldDestroy: boolean; }
let projectiles: Projectile[] = [];

// 瞄準與感應器系統變數
let targetYaw = 0, targetPitch = 0, currentYaw = 0, currentPitch = 0;
const PITCH_LIMIT = Math.PI / 2.25;
const TOUCH_SENSITIVITY = 0.0025, GYRO_SENSITIVITY = 0.0015, LERP_FACTOR = 0.15;
let lastTouchX = 0, lastTouchY = 0, lastGyroBeta = 0, lastGyroGamma = 0, isGyroInitialized = false;

let isCharging = false, chargeTimer = 0;
const baseLaunchSpeed = 15, maxLaunchSpeed = 35;
let currentLaunchSpeed = baseLaunchSpeed;

let trajectoryLine: THREE.Line;
const PREDICTION_POINTS = 40, PREDICTION_TIME_STEP = 0.04;

// 🚀 動態獲取橫屏維度資訊（核心魔術：如果是直向，把寬高互換傳給 Three.js）
function getGameSize() {
  const isForcedLandscape = window.innerHeight > window.innerWidth;
  return {
    width: isForcedLandscape ? window.innerHeight : window.innerWidth,
    height: isForcedLandscape ? window.innerWidth : window.innerHeight,
    isForced: isForcedLandscape
  };
}

startBtn.addEventListener('click', async () => {
  // 🚀 第一道保險：嘗試原生鎖定橫屏 (Android Chrome 支援)
  if (screen.orientation && (screen.orientation as any).lock) {
    try { await (screen.orientation as any).lock('landscape'); } catch (e) { console.log("瀏覽器不支援 API 自動鎖定橫屏，啟用 CSS 防線。"); }
  }

  await requestGyroPermission();
  startOverlay.classList.add('hidden');
  
  await RAPIER.init();
  physicsWorld = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
  
  initThree();
  
  multiplayerManager = new MultiplayerManager(scene, camera);
  multiplayerManager.connect('http://localhost:3000');
  multiplayerManager.onRemoteFire((startPos, launchDir, speed) => {
    spawnRubberBand(startPos, launchDir, speed, false);
  });
});

async function requestGyroPermission() {
  const DeviceOrientation = DeviceOrientationEvent as unknown as DeviceOrientationEventWithPermission;
  if (typeof DeviceOrientation.requestPermission === 'function') {
    try {
      const state = await DeviceOrientation.requestPermission();
      if (state === 'granted') window.addEventListener('deviceorientation', onDeviceOrientation, true);
    } catch (e) { console.error(e); }
  } else {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#78909c');
  scene.fog = new THREE.FogExp2('#78909c', 0.03);

  const size = getGameSize();
  camera = new THREE.PerspectiveCamera(60, size.width / size.height, 0.1, 1000);
  camera.position.set(0, 1.8, 5);
  camera.rotation.order = 'YXZ';

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(size.width, size.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const ambient = new THREE.AmbientLight('#ffffff', 0.5);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight('#ffffff', 0.9);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  scene.add(dirLight);

  createPhysicsEnvironment();
  initTrajectoryLine();
  setupMobileInputs();

  window.addEventListener('resize', onWindowResize);
  animate();
}

function initTrajectoryLine() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREDICTION_POINTS * 3), 3));
  trajectoryLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#ffeb3b', transparent: true, opacity: 0.8 }));
  trajectoryLine.visible = false;
  scene.add(trajectoryLine);
}

function createPhysicsEnvironment() {
  const groundMat = new THREE.MeshStandardMaterial({ color: '#4caf50', flatShading: true, roughness: 0.9 });
  const groundMesh = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  const groundBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physicsWorld.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.1, 20), groundBody);

  const bottleMat = new THREE.MeshStandardMaterial({ color: '#1b5e20', flatShading: true, roughness: 0.3 });
  for (let i = 0; i < 3; i++) {
    const bottleGroup = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 6), bottleMat);
    body.position.y = 0.45; body.castShadow = true; bottleGroup.add(body);
    
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.3, 6), bottleMat);
    neck.position.y = 1.05; neck.castShadow = true; bottleGroup.add(neck);

    const x = -1.5 + i * 1.5, z = -3;
    bottleGroup.position.set(x, 0, z);
    scene.add(bottleGroup);

    const bBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.6, z).setMass(1.0));
    physicsWorld.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 0.2), bBody);
    physicsPairs.push({ mesh: bottleGroup, body: bBody });
  }
}

// --- 輸入事件監聽與軸向動態校正 ---
function setupMobileInputs() {
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0) {
      lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
      isCharging = true; chargeTimer = 0; trajectoryLine.visible = true;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      const size = getGameSize();
      let dx = e.touches[0].clientX - lastTouchX;
      let dy = e.touches[0].clientY - lastTouchY;

      // 🚀 核心優化：如果目前是被 CSS 強制旋轉的，手指劃動方向必須交叉反轉
      if (size.isForced) {
        const tempX = dy;
        const tempY = -dx;
        dx = tempX;
        dy = tempY;
      }

      targetYaw -= dx * TOUCH_SENSITIVITY; 
      targetPitch -= dy * TOUCH_SENSITIVITY;
      targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
      
      lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
    }
  }, { passive: true });

  canvas.addEventListener('touchend', () => {
    if (isCharging) {
      const launchDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      const startPos = camera.position.clone().add(launchDir.clone().multiplyScalar(0.5));
      
      spawnRubberBand(startPos, launchDir, currentLaunchSpeed, true);
      isCharging = false; trajectoryLine.visible = false;
    }
  });
}

function onDeviceOrientation(e: DeviceOrientationEvent) {
  if (e.beta === null || e.gamma === null) return;
  if (!isGyroInitialized) { lastGyroBeta = e.beta; lastGyroGamma = e.gamma; isGyroInitialized = true; return; }
  
  const size = getGameSize();
  let deltaPitch = e.beta - lastGyroBeta;
  let deltaYaw = e.gamma - lastGyroGamma;

  // 🚀 核心優化：如果系統處於直向鎖定，但玩家橫拿手機，陀螺儀的 X/Y 實體物理軸向會互換，在此進行配對修正
  if (size.isForced) {
    const tmp = deltaPitch;
    deltaPitch = -deltaYaw;
    deltaYaw = tmp;
  }
  
  targetPitch += deltaPitch * GYRO_SENSITIVITY;
  targetYaw += deltaYaw * GYRO_SENSITIVITY;
  targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
  
  lastGyroBeta = e.beta; lastGyroGamma = e.gamma;
}

function updateTrajectory() {
  if (!isCharging) return;
  chargeTimer += 1 / 60;
  currentLaunchSpeed = baseLaunchSpeed + (maxLaunchSpeed - baseLaunchSpeed) * Math.min(chargeTimer, 1.5);

  const launchDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const startPos = camera.position.clone().add(launchDir.clone().multiplyScalar(0.5));
  const v0 = launchDir.multiplyScalar(currentLaunchSpeed);
  const g = physicsWorld.gravity.y;
  const attr = trajectoryLine.geometry.getAttribute('position') as THREE.BufferAttribute;

  for (let i = 0; i < PREDICTION_POINTS; i++) {
    const t = i * PREDICTION_TIME_STEP;
    attr.setXYZ(i, startPos.x + v0.x * t, startPos.y + v0.y * t + 0.5 * g * t * t, startPos.z + v0.z * t);
  }
  attr.needsUpdate = true;
}

function spawnRubberBand(startPos: THREE.Vector3, launchDir: THREE.Vector3, speed: number, isLocal: boolean) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.2, 4, 8), new THREE.MeshStandardMaterial({ color: isLocal ? '#ff5722' : '#00abc5', flatShading: true }));
  mesh.castShadow = true; scene.add(mesh);

  const body = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(startPos.x, startPos.y, startPos.z).setCcdEnabled(true));
  physicsWorld.createCollider(RAPIER.ColliderDesc.capsule(0.1, 0.1).setRestitution(0.5), body);
  body.applyImpulse({ x: launchDir.x * speed * 0.2, y: launchDir.y * speed * 0.2, z: launchDir.z * speed * 0.2 }, true);

  projectiles.push({ mesh, body, spawnTime: performance.now(), shouldDestroy: false });

  if (isLocal && multiplayerManager) multiplayerManager.emitFire(startPos, launchDir, speed);
}

function cleanupProjectiles() {
  const now = performance.now();
  projectiles = projectiles.filter((p) => {
    const isExpired = now - p.spawnTime > 3000 || p.body.translation().y < -2;
    if (isExpired) {
      scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose();
      physicsWorld.removeRigidBody(p.body);
      return false;
    }
    return true;
  });
}

function animate() {
  requestAnimationFrame(animate);

  currentYaw += (targetYaw - currentYaw) * LERP_FACTOR;
  currentPitch += (targetPitch - currentPitch) * LERP_FACTOR;
  camera.rotation.x = currentPitch; camera.rotation.y = currentYaw;

  if (multiplayerManager) {
    multiplayerManager.updateSelfTransform();
    multiplayerManager.updateRemotePlayersInterpolation();
  }

  updateTrajectory();
  physicsWorld.step();

  physicsPairs.forEach((pair) => {
    const t = pair.body.translation(), r = pair.body.rotation();
    pair.mesh.position.set(t.x, t.y, t.z); pair.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  });
  projectiles.forEach((p) => {
    const t = p.body.translation(), r = p.body.rotation();
    p.mesh.position.set(t.x, t.y, t.z); p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  });

  cleanupProjectiles();
  renderer.render(scene, camera);
}

function onWindowResize() {
  const size = getGameSize();
  camera.aspect = size.width / size.height; 
  camera.updateProjectionMatrix();
  renderer.setSize(size.width, size.height);
    }
