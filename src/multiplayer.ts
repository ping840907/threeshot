import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';

interface RemotePlayer {
  id: string;
  mesh: THREE.Group;
  targetPosition: THREE.Vector3;
  targetQuaternion: THREE.Quaternion;
}

export class MultiplayerManager {
  private socket!: Socket;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private remotePlayers: Map<string, RemotePlayer> = new Map();
  private lastEmitTime = 0;
  private emitInterval = 50; 

  private onRemoteFireCallback?: (startPos: THREE.Vector3, launchDir: THREE.Vector3, speed: number) => void;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
  }

  public connect(serverUrl: string) {
    this.socket = io(serverUrl);

    this.socket.on('current_players', (players: any) => {
      Object.keys(players).forEach((id) => {
        if (id !== this.socket.id) this.spawnRemotePlayer(players[id]);
      });
    });

    this.socket.on('player_joined', (playerData: any) => {
      this.spawnRemotePlayer(playerData);
    });

    this.socket.on('player_updated', (playerData: any) => {
      const p = this.remotePlayers.get(playerData.id);
      if (p) {
        p.targetPosition.set(playerData.position.x, playerData.position.y, playerData.position.z);
        p.targetQuaternion.set(playerData.rotation.x, playerData.rotation.y, playerData.rotation.z, playerData.rotation.w);
      }
    });

    this.socket.on('player_fired', (fireData: any) => {
      if (this.onRemoteFireCallback) {
        const startPos = new THREE.Vector3(fireData.startPos.x, fireData.startPos.y, fireData.startPos.z);
        const launchDir = new THREE.Vector3(fireData.launchDir.x, fireData.launchDir.y, fireData.launchDir.z);
        this.onRemoteFireCallback(startPos, launchDir, fireData.speed);
      }
    });

    this.socket.on('player_left', (id: string) => {
      const p = this.remotePlayers.get(id);
      if (p) {
        this.scene.remove(p.mesh);
        p.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.remotePlayers.delete(id);
      }
    });
  }

  public onRemoteFire(callback: (startPos: THREE.Vector3, launchDir: THREE.Vector3, speed: number) => void) {
    this.onRemoteFireCallback = callback;
  }

  public emitFire(startPos: THREE.Vector3, launchDir: THREE.Vector3, speed: number) {
    if (this.socket?.connected) {
      this.socket.emit('fire', { startPos, launchDir, speed });
    }
  }

  private spawnRemotePlayer(data: any) {
    const dummyGroup = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: data.color, flatShading: true, roughness: 0.6 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.0, 0.4), material);
    torso.position.y = 0.5; torso.castShadow = true; dummyGroup.add(torso);

    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4, 6), material);
    head.position.y = 1.2; head.castShadow = true; dummyGroup.add(head);

    dummyGroup.position.set(data.position.x, data.position.y, data.position.z);
    this.scene.add(dummyGroup);

    this.remotePlayers.set(data.id, {
      id: data.id,
      mesh: dummyGroup,
      targetPosition: new THREE.Vector3(data.position.x, data.position.y, data.position.z),
      targetQuaternion: new THREE.Quaternion(data.rotation.x, data.rotation.y, data.rotation.z, data.rotation.w)
    });
  }

  public updateSelfTransform() {
    if (!this.socket?.connected) return;
    const now = performance.now();
    if (now - this.lastEmitTime > this.emitInterval) {
      const pos = this.camera.position;
      const q = this.camera.quaternion;
      this.socket.emit('update_transform', {
        position: { x: pos.x, y: pos.y, z: pos.z },
        rotation: { x: q.x, y: q.y, z: q.z, w: q.w }
      });
      this.lastEmitTime = now;
    }
  }

  public updateRemotePlayersInterpolation() {
    const lerpFactor = 0.15;
    this.remotePlayers.forEach((player) => {
      player.mesh.position.lerp(player.targetPosition, lerpFactor);
      player.mesh.quaternion.slerp(player.targetQuaternion, lerpFac
                                   tor);
    });
  }
}
