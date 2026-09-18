/* SCENE — everything Three.js that exists exactly once: renderer, camera,
   lights, the floor plate, the instanced pod rings and the focus/hover
   rings. Per-frame placement of these lives in scene/layout.js; this
   class only builds and owns them. */
import * as THREE from 'three';
import { CFG, GROUP_RGB } from '../config.js';
import { FLOOR_VERT, FLOOR_FRAG } from './floor-shader.js';

function makeRing(scene, inner, outer, color, opacity){
  const g = new THREE.RingGeometry(inner, outer, 64);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, fog: false
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

export class ShowroomScene {
  constructor(stage){
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    stage.appendChild(renderer.domElement);

    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x06021a, 0.016);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 900);

    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const key1 = new THREE.DirectionalLight(0xfff0e8, 0.62); key1.position.set(6, 10, 8);
    const key2 = new THREE.DirectionalLight(0x8ae0ff, 0.42); key2.position.set(-7, 5, -6);
    scene.add(key1, key2);

    /* ---- infinite floor -----------------------------------------------
       Drawn as a plate that rides along under the camera target; the grid
       itself is evaluated in world coordinates by scene/floor-shader.js. */
    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uCenter: { value: new THREE.Vector2() },
        uCell:   { value: CFG.CELL },
        uPeriod: { value: new THREE.Vector2(12, 10) },
        uFade:   { value: 60 },
        uColA:   { value: new THREE.Color(0x2c6bff) },
        uColB:   { value: new THREE.Color(0x00f5d4) },
        uPinC:   { value: new THREE.Vector2() },
        uPinR:   { value: 0 },
        uPinOn:  { value: 0 }
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      extensions: { derivatives: true }
    });
    const floor = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.frustumCulled = false;
    floor.renderOrder = -10;
    scene.add(floor);

    /* ---- pods ---------------------------------------------------------
       One instanced ring per occupied cell, tinted by the specimen's
       symmetry group.  When an axis enumerates the subgroups the floor reads
       as coloured bands, which is a surprisingly good navigational aid. */
    const ringGeo = new THREE.RingGeometry(0.70, 0.99, 44);
    ringGeo.rotateX(-Math.PI / 2);
    {
      const n = ringGeo.attributes.position.count;
      const rc = new Float32Array(n * 3).fill(1);
      ringGeo.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    }
    const podMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false
    });
    const pods = this.pods = new THREE.InstancedMesh(ringGeo, podMat, CFG.POD_MAX);
    pods.frustumCulled = false;
    pods.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pods.setColorAt(0, GROUP_RGB[0]);
    scene.add(pods);

    this.focusRing = makeRing(scene, 1.02, 1.16, 0x00f5d4, 0.95);
    this.hoverRing = makeRing(scene, 1.02, 1.09, 0xff3ea5, 0.5);

    /* Specimen meshes are added here by the virtualiser. */
    this.blocksG = new THREE.Group();
    scene.add(this.blocksG);
  }

  get domElement(){ return this.renderer.domElement; }

  resize(){
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(){ this.renderer.render(this.scene, this.camera); }
}
