import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createMonkey } from './monkey.js';

export function createScene(container, { onAct, onLook = () => {} }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#a9dded');
  scene.fog = new THREE.Fog('#a9dded', 18, 60);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 40);
  camera.position.set(0, 5.8, 7.2);
  camera.lookAt(0, 2.1, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft shadows cost a lot on integrated GPUs
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentRoom = new RoomEnvironment();
  const environment = pmrem.fromScene(environmentRoom, 0.04);
  scene.environment = environment.texture;
  environmentRoom.dispose();
  scene.environmentIntensity = 0.32;
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(640,400), .16, .25, 1.5);
  const outputPass = new OutputPass();
  composer.addPass(renderPass); composer.addPass(bloom); composer.addPass(outputPass);
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
  container.appendChild(canvas);
  const vignette = document.createElement('div');
  Object.assign(vignette.style, { position: 'absolute', inset: '0', pointerEvents: 'none', opacity: '0',
    background: 'radial-gradient(ellipse at center, transparent 38%, rgba(0,0,0,.7) 85%, #000 100%)' });
  container.appendChild(vignette);

  let state = null, bombSignature, playersSignature, disposed = false;
  let bomb = new THREE.Group(), monkeys = new THREE.Group();
  scene.add(bomb, monkeys, camera);
  let selfMonkey = null, localEmote = null, localEmoteAt = 0;
  let targets = [], monkeyRecords = [], timer = null, strikeLights = [], sliderKnob = null, blindBuild = false;
  let heldModule = null, hovering = null, held = false, leaning = false, flashAt = -Infinity, lookSpeed = 1, lowQuality = false;
  let frame, lastFrame = performance.now(), receivedAt = lastFrame, seatKey = null;
  const pointer = new THREE.Vector2(9, 9), look = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const goal = new THREE.Vector3(), aim = new THREE.Vector3(), smoothAim = new THREE.Vector3(0, 1.5, 1);
  const ambient = new THREE.HemisphereLight('#ffe5b3', '#403a30', 2.2);
  const lamp = new THREE.PointLight('#ffbc72', 90, 18, 2);
  lamp.position.set(-2, 7, 2);
  const fill = new THREE.PointLight('#86b8a8', 35, 15, 2);
  fill.position.set(4, 5, -4);
  scene.add(ambient, lamp, fill);
  const sun = new THREE.DirectionalLight('#fff0d3', 3);
  sun.position.set(-3, 7, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {left:-5,right:5,top:5,bottom:-5});
  sun.shadow.normalBias = 0.04;
  scene.add(sun);

  // The van never moves, so its hundred-odd separate parts are baked into one mesh per
  // look (colour, glow, shadow): far fewer draw calls for slower GPUs.
  function mergeStatic(group) {
    group.updateMatrixWorld(true);
    const buckets = new Map(), merged = [];
    group.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.material.transparent || o.material.map || !o.material.color) return;
      const m = o.material, key = [m.color.getHex(), m.emissive?.getHex(), m.emissiveIntensity, m.roughness, m.metalness, o.castShadow].join();
      if (!buckets.has(key)) buckets.set(key, { material: m, castShadow: o.castShadow, geometries: [] });
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      g.applyMatrix4(o.matrixWorld);
      buckets.get(key).geometries.push(g);
      merged.push(o);
    });
    for (const o of merged) { o.removeFromParent(); o.geometry.dispose(); }
    for (const { material, castShadow, geometries } of buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(geometries), material);
      mesh.castShadow = castShadow; mesh.receiveShadow = true;
      geometries.forEach((g) => g.dispose());
      group.add(mesh);
    }
  }
  // Game colors by name, matched to the manual's color dots (style.css .sw-*), so a "blue"
  // light on the bomb is the same blue Mute sees in the manual.
  // The 3D shades sit a little deeper because the van's bright lighting and filmic tone
  // mapping lift and desaturate them; on screen they land on the manual's colors.
  const GAME_COLORS = { red: '#c4180f', blue: '#1440c4', green: '#16902c', yellow: '#e0b000', white: '#f4f2ea', black: '#111111' };
  const PLATE_COLORS = { red: '#e33b2e', blue: '#3466e0', green: '#36b24a', yellow: '#f5d235', white: '#ffffff', black: '#111111' };
  function material(color, glow = 0) {
    color = GAME_COLORS[color] ?? color;
    return new THREE.MeshStandardMaterial({ color, roughness: 0.68, emissive: color, emissiveIntensity: glow });
  }
  function mesh(parent, geometry, color, x, y, z, glow = 0) {
    const object = new THREE.Mesh(geometry, material(color, glow));
    object.position.set(x, y, z);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function box(parent, size, color, x, y, z, glow = 0) {
    return mesh(parent, new RoundedBoxGeometry(...size, 2, Math.min(...size) * 0.18), color, x, y, z, glow);
  }
  function sphere(parent, size, color, x, y, z) {
    const object = mesh(parent, new THREE.SphereGeometry(1, 32, 20), color, x, y, z);
    object.scale.set(...size);
    return object;
  }
  function cylinder(parent, radius, height, color, x, y, z, glow = 0) {
    return mesh(parent, new THREE.CylinderGeometry(radius, radius, height, 24), color, x, y, z, glow);
  }
  function textSurface(text, width, height, fg = '#eee4c9', bg = '#262a27', canvasHeight) {
    const W = 512, H = canvasHeight ?? Math.max(64, Math.min(512, Math.round(W * height / width)));
    const image = document.createElement('canvas');
    image.width = W;
    image.height = H;
    const context = image.getContext('2d');
    const texture = new THREE.CanvasTexture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    function draw(value, color = fg, background = bg) {
      context.clearRect(0, 0, W, H);
      context.fillStyle = background;
      context.beginPath(); context.roundRect(0, 0, W, H, H * 0.19); context.fill();
      context.fillStyle = color;
      context.font = `bold ${Math.round(H * 0.62)}px system-ui, "Segoe UI Symbol", "Apple Symbols", sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(value), W / 2, H * 0.54, W * 0.92);
      texture.needsUpdate = true;
    }
    draw(text);
    const object = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    return { object, draw, context, texture };
  }
  function plate(parent, text, width, height, x, y, z, fg, bg, canvasHeight) {
    // Blind feels raised labels but sees no colors: draw them white on black.
    if (blindBuild) [fg, bg] = ['#f4f4f4', '#000000'];
    const result = textSurface(text, width, height, PLATE_COLORS[fg] ?? fg, PLATE_COLORS[bg] ?? bg, canvasHeight);
    result.object.rotation.x = -Math.PI / 2;
    result.object.position.set(x, y, z);
    parent.add(result.object);
    return result;
  }
  function sprite(parent, text, width, height, y, fg, bg) {
    const surface = textSurface(text, width, height, fg, bg);
    const object = new THREE.Sprite(new THREE.SpriteMaterial({ map: surface.texture, depthTest: true, transparent: true, toneMapped: false }));
    surface.object.geometry.dispose();
    surface.object.material.dispose();
    object.scale.set(width, height, 1);
    object.position.y = y;
    parent.add(object);
    return object;
  }
  function destroy(group) {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const mat of [].concat(object.material || [])) {
        materials.add(mat);
        for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
      }
    });
    textures.forEach((item) => item.dispose());
    materials.forEach((item) => item.dispose());
    geometries.forEach((item) => item.dispose());
    group.removeFromParent();
  }

  const room = new THREE.Group();
  scene.add(room);
  // Deep teal panels, rust upholstery and walnut trim keep the cabin distinct.
  const detailTransform = new THREE.Object3D();
  const detailColor = new THREE.Color();
  const roundedDetail = new RoundedBoxGeometry(1, 1, 1, 2, .12);
  const roundDetail = new THREE.SphereGeometry(1, 12, 8);
  function instances(parent, geometry, pieces, glow = 0) {
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .8,
      emissive: '#ffe0ac', emissiveIntensity: glow });
    const batch = new THREE.InstancedMesh(geometry, mat, pieces.length);
    pieces.forEach((piece, i) => {
      detailTransform.position.set(...piece.at);
      detailTransform.scale.set(...piece.size);
      detailTransform.updateMatrix();
      batch.setMatrixAt(i, detailTransform.matrix);
      batch.setColorAt(i, detailColor.set(piece.color));
    });
    batch.receiveShadow = true;
    parent.add(batch);
    return batch;
  }
  const cabinSlab = (size, color, x, y, z) => mesh(room, new THREE.BoxGeometry(...size,
    Math.max(1, Math.ceil(size[0])), Math.max(1, Math.ceil(size[1])), Math.max(1, Math.ceil(size[2]))), color, x, y, z);
  const trim = [], folds = [], bulbs = [];
  const detail = (list, at, size, color) => list.push({ at, size, color });
  cabinSlab([4.6, .22, 8], '#493021', 0, -.1, 0);
  for (let i=0; i<16; i++) detail(trim, [0,.025,-3.75+i*.5], [4.4,.035,.47], i%3 ? '#805331' : '#98633b');
  cabinSlab([4.6, .18, 8], '#b89059', 0, 3.65, 0);
  cabinSlab([4.6, 3.6, .18], '#16494d', 0, 1.8, 3.8);
  cabinSlab([2.65,.025,3.1], '#274a51', 0,.065,.5);
  for (const x of [-1.22,1.22]) detail(trim,[x,.083,.5],[.05,.01,2.9],'#f4d3a0');
  for (const side of [-1, 1]) {
    cabinSlab([.18, 1.4, 8], '#16494d', side * 2.3, .7, 0);
    cabinSlab([.18, .55, 8], '#b89059', side * 2.3, 3.4, 0);
    cabinSlab([.2,1.85,1.15], '#16494d', side*2.3,2.25,3.38);
    detail(trim,[side*2.18,3.55,0],[.14,.18,8],'#533b29');
    for (const y of [.25,.65,1.05]) detail(trim,[side*2.19,y,0],[.025,.025,7.7],'#10363b');
    for (const z of [-3.8, -1.6, .6, 2.8]) detail(trim,[side*2.27,2.3,z],[.23,2.4,.16],'#533b29');
    for (const z of [-2.7, -.5, 1.7]) {
      for (const y of [1.43,3.12]) detail(trim,[side*2.2,y,z],[.27,.12,2.13],'#a8723f');
      for (const dz of [-.84,.84]) {
        for (let f=0; f<4; f++) detail(folds,[side*(2.11+(f%2)*.025),2.36,z+dz+(f-1.5)*.075],
          [.12,1.42,.095],f%2?'#ac7624':'#d09a32');
        detail(trim,[side*2.025,2.05,z+dz],[.055,.10,.34],'#efc472');
      }
      detail(trim,[side*2.12,3.19,z],[.12,.09,2.1],'#aa754b');
    }
    detail(trim,[side*2.13,3.48,0],[.07,.045,7.4],'#9f7851');
    for(let i=0;i<15;i++) detail(bulbs,[side*2.10,3.43-Math.sin(i/14*Math.PI)*.10,-3.5+i*.5],
      [.055,.075,.055],i%3?'#ffe2a1':'#f5ad85');
  }
  // The windshield opening is bounded on every side by the cab shell.
  cabinSlab([4.6,1.45,.22], '#16494d',0,.725,-3.9);
  cabinSlab([4.6,.48,.22], '#16494d',0,3.4,-3.9);
  for(const x of [-2.19,2.19]) cabinSlab([.25,2,.28], '#533b29',x,2.3,-3.88);
  for(const y of [1.49,3.14]) cabinSlab([4.2,.13,.26], '#a8723f',0,y,-3.87);
  cabinSlab([.10,1.65,.20], '#533b29',0,2.32,-3.87);
  const windshield = new THREE.Mesh(new THREE.PlaneGeometry(4.12,1.53),
    new THREE.MeshStandardMaterial({color:'#69b9bb',transparent:true,opacity:.12,roughness:.2,depthWrite:false,side:THREE.DoubleSide}));
  windshield.position.set(0,2.32,-3.91); room.add(windshield);
  for(const side of [-1,1]) cabinSlab([.24,3.6,.3], '#16494d',side*2.3,1.8,-3.87);
  cabinSlab([4.4,.48,.86], '#172f32',0,1.2,-3.43);
  cabinSlab([4.4,.10,.91], '#69472f',0,1.48,-3.43);
  box(room,[.84,.26,.12],'#101e23',-1.1,1.63,-3.02);
  for(const x of [-1.32,-1.02]) {
    const gauge=cylinder(room,.09,.025,'#dfb863',x,1.65,-2.94);
    gauge.rotation.x=Math.PI/2;
  }
  // The wheel sits out in front of the gauges on its own column, clear of the dashboard.
  const steering = new THREE.Group(); steering.position.set(-1.1,1.6,-2.62); steering.rotation.x=-.5; room.add(steering);
  const column = cylinder(room,.045,.42,'#172529',-1.1,1.5,-2.82); column.rotation.x = Math.PI / 2 - .5;
  mesh(steering,new THREE.TorusGeometry(.32,.045,8,24),'#172529',0,0,0);
  box(steering,[.60,.035,.05],'#9b784d',0,0,0);
  box(steering,[.035,.3,.05],'#9b784d',0,-.14,0);
  sphere(steering,[.085,.085,.055],'#172529',0,0,0);
  cylinder(room,.12,.60,'#24383b',-1.1,.37,-2.47);
  box(room,[.84,.22,.78],'#a03e20',-1.1,.78,-2.47);
  box(room,[.84,.87,.22],'#79301d',-1.1,1.22,-2.12);
  for(const x of [-1.34,-.86]) cylinder(room,.026,.25,'#9b784d',x,1.75,-2.12);
  box(room,[.58,.28,.23],'#a03e20',-1.1,1.94,-2.12);
  box(room,[.65,1.0,1.15],'#704b2e',-1.95,.55,-1.2);
  cabinSlab([.75,.10,1.23],'#bd8b50',-1.95,1.1,-1.2);
  for(const y of [.3,.78]) {
    detail(trim,[-1.61,y,-1.2],[.035,.4,1.03],'#956232');
    detail(trim,[-1.57,y,-1.2],[.045,.045,.22],'#24383b');
  }
  box(room, [2.3, .1, 1.8], '#164f39', 0, 1.2, .55);
  box(room, [2.38, .06, 1.88], '#e4bd7e', 0, 1.14, .55);
  cylinder(room, .09, 1.1, '#5c5f66', 0, .6, .55);
  box(room, [.8, .06, .8], '#5c5f66', 0, .03, .55);
  // lift raises the whole bench for a seat that sits higher.
  function bench(x, z, along, lift = 0) {
    const w = along ? [1.7, .5 + lift, .95] : [.95, .5 + lift, 1.7];
    const benchStart = room.children.length;
    box(room, w, '#543620', x, (.5 + lift) / 2, z);
    const bx = along ? x : x + Math.sign(x) * .55, bz = along ? z + Math.sign(z - .55) * .55 : z;
    box(room, along ? [1.76,1.27,.28] : [.28,1.27,1.76], '#492a20',bx,1.35,bz);
    for(const offset of [-.43,.43]) {
      const sx=x+(along?offset:0), sz=z+(along?0:offset);
      box(room,along?[.82,.25,.92]:[.92,.25,.82],'#ad4825',sx,.64,sz);
      box(room,along?[.82,.045,.93]:[.93,.045,.82],'#d1954c',sx,.735,sz);
      box(room,along?[.81,.045,.91]:[.91,.045,.81],'#ad4825',sx,.76,sz);
      const cx=bx+(along?offset:-Math.sign(x)*.04), cz=bz+(along?-Math.sign(z-.55)*.04:offset);
      box(room,along?[.82,1.12,.27]:[.27,1.12,.82],'#ce8840',cx,1.36,cz);
      box(room,along?[.75,1.04,.29]:[.29,1.04,.75],'#9d391f',cx,1.36,cz);
    }
    for (const part of room.children.slice(benchStart + 1)) part.position.y += lift;
  }
  bench(0, 2.15, true); bench(1.65, 1.3, false); bench(.9, -2.25, true, .25); bench(-1.65, .55, false);
  cylinder(room,.045,.22,'#8d6848',0,3.45,.55);
  mesh(room,new THREE.CylinderGeometry(.22,.38,.25,24),'#e4b46b',0,3.26,.55);
  cylinder(room,.29,.025,'#fff0b8',0,3.13,.55,.7);
  // Storage stays against the shell, outside the seated players' sightlines.
  const supplies = [], jars = [], jarLids = [], greenery = [];
  for (const side of [-1, 1]) {
    detail(trim,[side*1.99,2.92,-.5],[.42,.10,1.65],'#956437');
    detail(trim,[side*1.78,3.01,-.5],[.045,.10,1.65],'#c99b60');
    for (let i=0;i<5;i++) {
      const z=-1.12+i*.30, h=.22+(i%3)*.055;
      detail(jars,[side*2.0,2.97+h/2,z],[.085,h,.085],['#7fae9a','#d2944b','#ba6551','#89a8bd','#d0b078'][i]);
      detail(jarLids,[side*2.0,2.985+h,z],[.095,.045,.095],'#ead2a0');
      detail(supplies,[side*1.911,3.04+h*.2,z],[.013,.09,.10],'#f6e4b7');
    }
  }
  // A compact rear galley leaves the aisle and every bench unobstructed.
  box(room,[.77,1.22,.68],'#bbd0b5',-1.65,.67,3.27);
  box(room,[.68,1.10,.06],'#e8dab4',-1.65,.69,2.90);
  detail(supplies,[-1.4,.93,2.85],[.06,.28,.06],'#775743');
  for(let i=0;i<3;i++) detail(supplies,[-1.82+i*.18,1.04-i*.10,2.858],[.10,.12,.018],['#d57c52','#73a7a5','#e0b34d'][i]);
  detail(trim,[-1.65,1.33,3.27],[.84,.09,.76],'#a87547');
  for (const x of [-1.65,1.65]) {
    detail(trim,[x,2.03,3.42],[.85,.10,.46],'#a87547');
    for(const dx of [-.30,.30]) detail(trim,[x+dx,1.88,3.58],[.075,.25,.16],'#533b29');
    for(let i=0;i<4;i++) detail(supplies,[x-.26+i*.16,2.28,3.48],[.12,.40-(i%2)*.08,.24],['#c9784a','#e0ba67','#628d8b','#99685e'][i]);
  }
  // Banana crate tucked behind the right bench.
  detail(trim,[1.65,.18,3.3],[.88,.12,.68],'#8d5b35');
  for(const y of [.30,.49]) {
    for(const z of [2.97,3.63]) detail(trim,[1.65,y,z],[.88,.13,.055],'#bb8951');
    for(const x of [1.22,2.08]) detail(trim,[x,y,3.3],[.055,.13,.68],'#bb8951');
  }
  const bananas = [];
  for(let i=0;i<7;i++) detail(bananas,[1.4+(i%3)*.23,.57+Math.floor(i/3)*.10,3.18+(i%2)*.21],[.13,.13,.13],i%2?'#efc748':'#ffd76b');
  const bananaCurve = new THREE.TorusGeometry(1,.27,5,8,Math.PI*.8);
  bananaCurve.rotateX(-Math.PI/2);
  instances(room,bananaCurve,bananas);
  // A chunky CRT and framed postcards face into the cabin.
  box(room,[1.12,.77,.12],'#4d3e32',.05,2.75,3.64);
  box(room,[.86,.57,.04],'#7fb5ac',.13,2.76,3.56,.18);
  detail(supplies,[-.43,2.56,3.55],[.055,.055,.035],'#dfa95c');
  detail(supplies,[-.43,2.72,3.55],[.055,.055,.035],'#dfa95c');
  const tv = textSurface('HAPPY CAMPERS',.76,.15,'#fff0bd','#527e7c',96);
  tv.object.position.set(.13,2.76,3.53); tv.object.rotation.y=Math.PI; room.add(tv.object);
  function postcard(text, x, y, width, color) {
    detail(trim,[x,y,3.68],[width+.10,.47,.04],'#b98b52');
    const art=textSurface(text,width,.36,'#fff0c9',color,192);
    art.object.position.set(x,y,3.65); art.object.rotation.y=Math.PI; room.add(art.object);
  }
  postcard('TAKE IT SLOW',-1.55,2.91,.93,'#b86342');
  postcard('BANANA CLUB',1.48,2.86,.98,'#427e7b');
  // Roof ribs, curtain rings and two loose cable runs add depth overhead.
  for(const z of [-2.7,-.7,1.4,3.3]) detail(trim,[0,3.52,z],[4.25,.065,.075],'#956b42');
  const rings=[];
  for(const side of [-1,1]) for(const z of [-2.7,-.5,1.7]) for(const dz of [-.95,-.79,.73,.89])
    detail(rings,[side*2.12,3.18,z+dz],[.065,.065,.065],'#edd3a0');
  const ringGeometry=new THREE.TorusGeometry(1,.18,5,8); ringGeometry.rotateY(Math.PI/2);
  instances(room,ringGeometry,rings);
  for(const x of [-1.7,1.7]) {
    const points=[-3.5,-1.8,0,1.8,3.5].map((z,i)=>new THREE.Vector3(x,3.49-(i%2)*.14,z));
    mesh(room,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),24,.017,5,false),'#4c4031',0,0,0);
  }
  const hangingPlant=new THREE.Group(); hangingPlant.position.set(-1.92,3.5,-2.95); room.add(hangingPlant);
  for(const x of [-.11,.11]) mesh(hangingPlant,new THREE.CylinderGeometry(.012,.012,.39,5),'#e5c894',x,-.20,0);
  mesh(hangingPlant,new THREE.CylinderGeometry(.18,.12,.23,8),'#c0754a',0,-.48,0);
  for(let i=0;i<8;i++) {
    const angle=i*Math.PI/4;
    detail(greenery,[Math.cos(angle)*.16,-.39-(i%3)*.09,Math.sin(angle)*.16],[.13,.075,.11],i%2?'#93af63':'#5c8f65');
  }
  instances(hangingPlant,roundDetail,greenery);
  instances(room,roundedDetail,supplies);
  instances(room,new THREE.CylinderGeometry(1,1,1,10),jars);
  instances(room,new THREE.CylinderGeometry(1,1,1,10),jarLids);
  instances(room,new THREE.BoxGeometry(1,1,1,4,4,4),trim);
  instances(room,roundedDetail,folds);
  instances(room,roundDetail,bulbs,.25);
  room.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  for (const o of room.children) if(o.position.y===1.2) o.castShadow=true;
  mergeStatic(room);

  const outside = new THREE.Group(); scene.add(outside);
  // Ground and road are plain boxes cut into 10-unit segments: long, thin rounded-box
  // triangles this big rasterise as dashed streaks across the view.
  const slab = (size, color, x, y, z) => mesh(outside, new THREE.BoxGeometry(...size,
    Math.max(1, Math.round(size[0] / 10)), 1, Math.max(1, Math.round(size[2] / 10))), color, x, y, z);
  // The road sits just under the windows so the van rides on it instead of floating.
  // Each surface leaves a gap for the van's footprint (|x| < 2.45, |z| < 4) so it never
  // shows through the floor.
  outside.position.y = .6;
  function roadSurface(width, color, y) {
    const side = width / 2 - 2.45;
    if (side > 0) for (const x of [-1, 1]) slab([side, y === -.35 ? .1 : .025, 180], color, x * (2.45 + side / 2), y, 0);
    for (const z of [-1, 1]) slab([Math.min(width, 4.9), y === -.35 ? .1 : .025, 86], color, 0, y, z * 47);
  }
  roadSurface(100,'#9dbd78',-.35);
  roadSurface(6.2,'#c6b997',-.28);
  roadSurface(5.5,'#75858a',-.26);
  for(const x of [-2.55,2.55]) slab([.07,.01,180],'#f4e6c2',x,-.24,0);
  // Vertex colours keep the sky smooth without a texture or another light.
  const skyGeometry=new THREE.SphereGeometry(35,24,12);
  const skyColors=[], skyPosition=skyGeometry.attributes.position;
  const horizon=new THREE.Color('#e4ebce'), zenith=new THREE.Color('#6bb9df');
  for(let i=0;i<skyPosition.count;i++) {
    const color=horizon.clone().lerp(zenith,THREE.MathUtils.clamp(skyPosition.getY(i)/29,0,1));
    skyColors.push(color.r,color.g,color.b);
  }
  skyGeometry.setAttribute('color',new THREE.Float32BufferAttribute(skyColors,3));
  const sky=new THREE.Mesh(skyGeometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,fog:false,depthWrite:false}));
  sky.renderOrder=-2; outside.add(sky);
  const sunDisc=new THREE.Mesh(new THREE.SphereGeometry(1.65,16,12),new THREE.MeshBasicMaterial({color:'#fff0bd',fog:false}));
  sunDisc.position.set(-15,17,-23); outside.add(sunDisc);
  const sunHalo=new THREE.Mesh(new THREE.SphereGeometry(2.15,16,12),new THREE.MeshBasicMaterial({color:'#fff0bd',transparent:true,opacity:.13,depthWrite:false,fog:false}));
  sunHalo.position.copy(sunDisc.position); outside.add(sunHalo);
  const scenery=[];
  function landscape(geometry, pieces, speed) {
    const batch=instances(outside,geometry,pieces);
    batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Moving instances span the full roadside strip, beyond their initial bounds.
    batch.frustumCulled=false;
    scenery.push({batch,pieces,speed});
  }
  const markings=[], trunks=[], leaves=[], hills=[], clouds=[], fence=[];
  for(let i=0;i<24;i++) detail(markings,[0,-.24,-70+i*4],[.1,.015,1.8],'#f9e4a8');
  for(let i=0;i<40;i++) {
    const side=i%2?1:-1, z=-70+Math.floor(i/2)*4.8;
    const x=side*(5.8+(i%5)*1.25), h=1.5+(i%4)*.3;
    detail(trunks,[x,h*.4-.25,z],[.22,h*.8,.22],'#987858');
    detail(leaves,[x,h,z],[.85,h*.65,.85],['#6caa7e','#87b66e','#5a9a80','#a3bc70'][i%4]);
    detail(leaves,[x+.48,h*.85,z+.12],[.65,.75,.65], '#85b77a');
    detail(leaves,[side*(3.8+(i%3)*.25),.22,z+1.4],[.6,.48,.65],i%2?'#b6c87b':'#8cb577');
    detail(fence,[side*3.65,.25,z],[.12,1.15,.14],'#f1d9ac');
    for(const y of [.15,.55]) detail(fence,[side*3.65,y,z+2.4],[.08,.09,4.8],'#ead1a4');
  }
  for(let i=0;i<16;i++) {
    detail(hills,[(i%2?1:-1)*(16+i%3*3),.2,-65+Math.floor(i/2)*13],[7,2.8+(i%3),9],i%2?'#86b69b':'#a3c18d');
    for(let j=0;j<3;j++) detail(clouds,[(i%2?1:-1)*(10+i%3*4)+j*.9,7+(i%3)*.65,-65+Math.floor(i/2)*13],
      [1.5, j===1?.8:.55,1], '#fff4df');
  }
  const farm=[], roofs=[], flowers=[], fields=[], mountains=[];
  for(let i=0;i<8;i++) {
    const side=i%2?1:-1, x=side*(10+(i%3)*2), z=-66+i*12;
    detail(farm,[x,.95,z],[2.8,2.5,3.2],i%3?'#e4c58c':'#bd7056');
    detail(roofs,[x,2.72,z],[2.35,1.3,2.6],i%3?'#a85f46':'#657f7b');
    detail(farm,[x+.8,3.0,z+.6],[.35,1.0,.40],'#be9b78');
    // Side windows face the road; pale frames read at a distance.
    for(const dz of [-.92,.92]) {
      detail(farm,[x-side*1.42,1.25,z+dz],[.06,.80,.65],'#f6e6b8');
      detail(farm,[x-side*1.46,1.25,z+dz],[.025,.60,.45],'#639999');
      detail(farm,[x-side*1.48,1.25,z+dz],[.02,.045,.46],'#f6e6b8');
    }
    detail(farm,[x-side*1.43,.5,z],[.07,1.45,.64],'#765b42');
    for(let row=0;row<5;row++) detail(fields,[side*(6.6+row*.7),-.23,z+4],[.43,.08,5.4],row%2?'#cdb566':'#a9b972');
    detail(farm,[side*4.5,.5,z+4],[.12,1.6,.14],'#987957');
    detail(farm,[side*4.5,1.22,z+4],[.14,.55,.92],i%2?'#d5ac5c':'#75a194');
    for(let f=0;f<8;f++) {
      const fx=side*(4.15+(f%3)*.28), fz=z+f*.42;
      detail(flowers,[fx,.16,fz],[.10,.14,.10],f%3?'#efcc79':'#e9a28c');
    }
    detail(mountains,[side*(23+(i%3)*2),1.5,-62+i*12],[7,8+(i%3)*2,9],i%2?'#8eaaa8':'#9bb5ac');
  }
  const roofGeometry=new THREE.ConeGeometry(1,1,4); roofGeometry.rotateY(Math.PI/4);
  landscape(new THREE.BoxGeometry(1,1,1),farm,5);
  landscape(roofGeometry,roofs,5);
  landscape(new THREE.BoxGeometry(1,1,1,1,1,3),fields,5);
  landscape(roundDetail,flowers,5);
  landscape(new THREE.ConeGeometry(1,1,6),mountains,.65);
  landscape(roundedDetail,markings,5);
  landscape(roundedDetail,trunks,5);
  landscape(roundDetail,leaves,5);
  landscape(roundedDetail,fence,5);
  landscape(roundDetail,hills,1.2);
  landscape(roundDetail,clouds,.45);
  // Scenery outside the windows is too far away for its shadows to matter.
  outside.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  const particles = new THREE.Group(); scene.add(particles);
  // Thrown bananas fly on their own for 5 seconds, bouncing round the inside of the van.
  const flyingBananas = new THREE.Group(); scene.add(flyingBananas);
  const BANANA_LIFE = 5;
  // Solid boxes [minX, maxX, minY, maxY, minZ, maxZ]: the table top, the bomb case and its lid.
  const SOLIDS = [[-1.15, 1.15, 1.1, 1.25, -.35, 1.45], [-1, 1, 1.25, 1.45, .02, 1.22], [-1, 1, 1.45, 2.0, -.08, .1]];
  let launched = 0;
  // Every client launches the same banana from the thrower's seat (not from its own view of
  // the hand) and steps it with a fixed timestep, so it flies and lands the same for everyone.
  const RELEASE_AT = new THREE.Vector3(-0.4, 2.75, 0.95);
  function launchBanana(monkey, playerId, { late = 0 }) {
    const seat = seatOf(playerId);
    if (!seat) return;
    launched++;
    const b = monkey.banana.clone();
    b.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.castShadow = true; } });
    b.visible = true;
    // Thrown the way the thrower was looking, lobbed a little above their line of sight.
    const [yaw, pitch] = bananaAims.get(playerId) ?? [0, 0];
    const facing = seat[2] + yaw, lob = THREE.MathUtils.clamp(pitch + 0.4, -0.7, 1.35);
    b.position.copy(RELEASE_AT).multiplyScalar(.79).applyAxisAngle(THREE.Object3D.DEFAULT_UP, facing).add(new THREE.Vector3(seat[0], seat[3], seat[1]));
    b.rotation.set(0, facing, 0);
    b.scale.setScalar(.79);
    const velocity = new THREE.Vector3(Math.sin(facing) * Math.cos(lob), Math.sin(lob), Math.cos(facing) * Math.cos(lob)).multiplyScalar(6.5);
    b.userData = { thrower: monkey, velocity, spin: new THREE.Vector3(11, 4.5, 1), born: performance.now() - Math.max(0, late), simulated: 0 };
    flyingBananas.add(b);
    while (flyingBananas.children.length > 8) dropBanana(flyingBananas.children[0]);
  }
  // The shape is shared with the banana in the monkey's hand, so only the cloned materials go.
  function dropBanana(b) {
    b.traverse((o) => { if (o.isMesh) o.material.dispose(); });
    b.removeFromParent();
  }
  // Each seated monkey is a body sphere and a head sphere: [centre, radius, monkey].
  const monkeyCenter = new THREE.Vector3();
  function monkeyColliders() {
    const list = [];
    const add = (monkey, x, y, z) => {
      list.push([new THREE.Vector3(x, y + 1.25, z), .45, monkey]);
      list.push([new THREE.Vector3(x, y + 2.05, z), .5, monkey]);
    };
    for (const { monkey } of monkeyRecords) { monkey.root.getWorldPosition(monkeyCenter); add(monkey, monkeyCenter.x, monkeyCenter.y, monkeyCenter.z); }
    // Your own monkey isn't drawn in third person, but bananas still bounce off you.
    if (selfMonkey && state?.game) {
      const me = state.players.findIndex((p) => p.id === state.you), seat = seats[seatIndex(state.players[me], me, state.players)];
      add(selfMonkey, seat[0], seat[3], seat[1]);
    }
    return list;
  }
  function seatOf(playerId) {
    const players = state?.players || [], i = players.findIndex((p) => p.id === playerId);
    return i < 0 ? null : seats[seatIndex(players[i], i, players)];
  }
  const STEP = 1 / 120;
  function stepBananas(now) {
    const bodies = flyingBananas.children.length ? monkeyColliders() : [];
    for (const b of [...flyingBananas.children]) {
      const age = (now - b.userData.born) / 1000;
      if (age > BANANA_LIFE) { dropBanana(b); continue; }
      // Catch up in fixed steps, so frame rate never changes where it ends up.
      while (b.userData.simulated + STEP <= age) { b.userData.simulated += STEP; stepBanana(b, STEP, bodies, b.userData.simulated); }
      const fade = 1 - Math.min(1, Math.max(0, (age - (BANANA_LIFE - .6)) / .6));
      b.traverse((o) => { if (o.isMesh) o.material.opacity = fade; });
    }
  }
  function stepBanana(b, dt, bodies, age) {
    {
      const { velocity, spin } = b.userData;
      velocity.y -= 9.8 * dt;
      const before = b.position.clone();
      b.position.addScaledVector(velocity, dt);
      const p = b.position, r = .12 * b.scale.x;
      // Walls, floor and ceiling of the van.
      for (const [axis, lo, hi] of [['x', -2.15, 2.15], ['y', .02, 3.5], ['z', -3.7, 3.65]]) {
        if (p[axis] - r < lo && velocity[axis] < 0) { p[axis] = lo + r; velocity[axis] *= -.55; bounced(b, axis); }
        if (p[axis] + r > hi && velocity[axis] > 0) { p[axis] = hi - r; velocity[axis] *= -.55; bounced(b, axis); }
      }
      // Monkeys: bounce off heads and bodies, but not the thrower's own just after letting go.
      for (const [center, radius, monkey] of bodies) {
        if (monkey === b.userData.thrower && age < .5) continue;
        const away = p.clone().sub(center), dist = away.length();
        if (dist >= radius + r || dist === 0) continue;
        away.divideScalar(dist);
        p.copy(center).addScaledVector(away, radius + r);
        const into = velocity.dot(away);
        if (into < 0) { velocity.addScaledVector(away, -1.6 * into); bounced(b, 'x'); }
      }
      // Table and bomb: bounce off whichever face it came through.
      for (const [x0, x1, y0, y1, z0, z1] of SOLIDS) {
        if (p.x < x0 || p.x > x1 || p.y - r > y1 || p.y + r < y0 || p.z < z0 || p.z > z1) continue;
        if (before.y - r >= y1 - .01) { p.y = y1 + r; velocity.y = Math.abs(velocity.y) * .5; bounced(b, 'y'); }
        else if (before.x < x0 || before.x > x1) { p.x = before.x; velocity.x *= -.5; bounced(b, 'x'); }
        else { p.z = before.z; velocity.z *= -.5; bounced(b, 'z'); }
      }
      // Resting on a surface: slide to a stop instead of jittering.
      const grounded = Math.abs(velocity.y) < .6 && (p.y - r <= .03 || SOLIDS.some(([x0, x1, , y1, z0, z1]) => p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1 && Math.abs(p.y - r - y1) < .03));
      if (grounded) { velocity.y = 0; velocity.x *= Math.exp(-dt * 4); velocity.z *= Math.exp(-dt * 4); spin.multiplyScalar(Math.exp(-dt * 5)); }
      b.rotation.x += spin.x * dt; b.rotation.y += spin.y * dt; b.rotation.z += spin.z * dt;
    }
  }
  function bounced(b, axis) {
    // Each bounce knocks the spin about a bit.
    b.userData.spin[axis === 'y' ? 'z' : 'y'] *= -.8;
    b.userData.spin.x *= .7;
  }
  let effectAt = -Infinity;
  function burst(smoke=false, origin=new THREE.Vector3(0,1.8,.55)) {
    for(let i=0;i<(smoke?14:45);i++) {
      const part = smoke ? sphere(particles,[.15,.15,.15],'#e0dad0',...origin) : box(particles,[.08,.03,.16],['#ffcd35','#f3806f','#77ddb0'][i%3],...origin);
      part.material.transparent=true;
      part.userData={born:performance.now(),smoke,velocity:new THREE.Vector3((Math.random()-.5)*3,1+Math.random()*3,(Math.random()-.5)*3)};
    }
  }
  // [x, z, facing, height]. Blind faces the open case, Deaf sits at its side with Mute in view,
  // Mute sits across the case from Blind, toward Deaf's side, so the lid never hides it from Deaf.
  const seats = [[0,2.15,Math.PI,0],[1.5,1.4,-2.08,0],[1.0,-2.2,-.35,.25],[-1.65,.55,Math.PI/2,0]];
  function seatIndex(player,index,players) {
    if(!state?.game) return [2,3,1,0][index%4];
    if(['hands','solo'].includes(player.role)) return 0;
    if(player.role==='reader') return 2;
    return players.slice(0,index).some(p=>['eyes','guide'].includes(p.role)) ? 3 : 1;
  }

  function actionable(object, action, enabled) {
    if (!enabled) return;
    object.userData.action = action;
    object.userData.baseGlow = object.material.emissiveIntensity;
    targets.push(object);
  }
  function outline(group) {
    const edges = [];
    group.traverse((o) => {
      if (!o.isMesh || o.material.map || o.userData.noOutline) return;
      o.material.dispose();
      o.material = new THREE.MeshBasicMaterial({ color: '#000000' });
      // Rounded boxes curve in small steps, so outline them as plain boxes of the same size.
      let shape = o.geometry;
      if (shape.type === 'RoundedBoxGeometry') {
        shape.computeBoundingBox();
        const size = shape.boundingBox.getSize(new THREE.Vector3());
        shape = new THREE.BoxGeometry(size.x, size.y, size.z);
      }
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(shape, 28), new THREE.LineBasicMaterial({ color: '#f4f4f4' }));
      if (shape !== o.geometry) shape.dispose();
      o.add(line);
      o.userData.edges = line;
      edges.push(line);
    });
    return edges;
  }
  const tmpScale = new THREE.Vector3();
  // Flashes modules: the buttons light up one after another, then pause, on a loop.
  let flashers = [];
  function stepFlashers(now) {
    for (const { buttons, sequence } of flashers) {
      const step = 750, cycle = sequence.length * step + 1500, t = now % cycle;
      const lit = t < sequence.length * step && t % step < 480 ? sequence[Math.floor(t / step)] : -1;
      buttons.forEach((b, k) => { b.material.emissiveIntensity = k === lit ? 1.8 : 0.05; });
    }
  }
  // Raised Braille dots (1-3 down the left column, 4-6 down the right), scaled to fit.
  const brailleTouch = [];
  const BRAILLE_DIGITS = { '1': 1, '1,2': 2, '1,4': 3, '1,4,5': 4, '1,5': 5, '1,2,4': 6 };
  // A lit indicator: bright core in its own color plus an additive halo that bloom picks up.
  let haloTexture = null;
  function shine(light) {
    // Lit like the timer digits: unshaded, over-bright and untouched by tone mapping, so
    // bloom makes it glow while the hue stays put.
    const base = light.material.color.clone();
    light.material.dispose();
    light.material = new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(2.3), toneMapped: false });
    if (!haloTexture) {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,.45)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
      haloTexture = new THREE.CanvasTexture(c);
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture, color: base, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }));
    halo.scale.setScalar(3.6);
    halo.userData.noOutline = true;
    light.add(halo);
  }
  function brailleDots(parent, dots, cx, y, cz, size = 1) {
    if (dots?.length) {
      // An invisible pad over the cell: Blind's finger on it reads the digit out.
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.42 * size, 0.12 * size, 0.55 * size), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      pad.position.set(cx, y + 0.04 * size, cz);
      pad.userData = { noOutline: true, brailleDigit: BRAILLE_DIGITS[dots.join()] };
      parent.add(pad);
      brailleTouch.push(pad);
    }
    return (dots ?? []).map((dot) => {
      const col = dot <= 3 ? 0 : 1, row = (dot - 1) % 3;
      // Dark raised dots on a pale plate: sighted monkeys see them but can't read them.
      return cylinder(parent, 0.045 * size, 0.05 * size, '#2f3330', cx + (col - 0.5) * 0.19 * size, y + 0.04 * size, cz + (row - 1) * 0.17 * size);
    });
  }
  function enterKey(parent, act, x, z, enabled) {
    const enter = box(parent, [0.95, 0.12, 0.24], '#3f6f9e', x, 2.65, z);
    act(enter, { kind: 'enter' }, enabled);
    const label = plate(parent, 'ENTER', 0.6, 0.15, x, 2.715, z, '#eef4ff', '#3f6f9e');
    label.object.userData.hitTarget = enter; targets.push(label.object);
  }
  function buildBomb(data) {
    hovering = null;
    destroy(bomb);
    bomb = new THREE.Group();
    scene.add(bomb);
    targets = [];
    flashers = [];
    brailleTouch.length = 0;
    timer = null;
    strikeLights = [];
    // Suitcase sized to sit on the table, lid toward Mute.
    blindBuild = !!state?.game && state.game.role.touch && !state.game.role.seeBomb;
    bomb.position.set(0, .44, .62);
    bomb.scale.setScalar(.4);
    sliderKnob = null;
    if (!state?.game) return;
    box(bomb, [5, 0.5, 3], '#303b39', 0, 2.28, 0);
    for (const x of [-2.5, 2.5]) box(bomb, [0.12, 0.55, 3.04], '#111a19', x, 2.28, 0);
    for (let i = 0; i < 14; i++) box(bomb, [.18, .2, .02], i % 2 ? '#222a2d' : '#e3b843', -2.3 + i * .35, 2.28, 1.51);
    // Upright lid at the back of the case: timer, serial and strike lights face Blind.
    const lid = new THREE.Group();
    lid.position.set(0, 2.53, -1.55);
    lid.rotation.x = -0.35;
    bomb.add(lid);
    box(lid, [5, 1.35, 0.2], '#303b39', 0, 0.68, 0);
    // Mute only gets the shell: the back of the lid faces them and the tray is empty.
    if (!data || state.game.role.id === 'reader') { box(bomb, [4.8, .05, 2.8], '#1c2422', 0, 2.5, 0); return; }
    box(lid, [4.7, 1.1, 0.05], '#4a5650', 0, 0.68, 0.12);
    timer = plate(lid, '', 2.1, 0.62, -0.75, 0.82, 0.15, undefined, undefined, 192);
    timer.object.rotation.x = 0;
    timer.object.material.color.setRGB(2.3,2.3,2.3);
    const serialPlate = plate(lid, data.serial ?? '', 1.25, 0.3, 1.35, 0.42, 0.15, '#1a221e', data.serial == null ? '#666666' : '#c4c1a8');
    serialPlate.object.rotation.x = 0;
    for (let i = 0; i < 3; i++) {
      const bulb = cylinder(lid, 0.13, 0.06, '#321916', 0.95 + i * 0.4, 0.95, 0.16);
      bulb.rotation.x = Math.PI / 2;
      strikeLights.push(bulb);
    }
    // Two rows of three module slots. Each module is built around x = 0 in its own
    // group, then shrunk into its slot.
    data.modules.forEach((module, index) => {
      const slot = new THREE.Group();
      // Up to three modules sit in one centered row; more fill a second row.
      const perRow = data.modules.length <= 3 ? data.modules.length : 3;
      const row = Math.floor(index / 3), col = index % 3;
      const rowCount = data.modules.length <= 3 ? 1 : 2;
      const inRow = row === 0 ? perRow : data.modules.length - 3;
      slot.position.set((col - (inRow - 1) / 2) * 1.62, 2.53, rowCount === 1 ? 0 : row === 0 ? -0.72 : 0.76);
      slot.scale.setScalar(0.7);
      bomb.add(slot);
      const mp = new THREE.Group();
      mp.position.set(0, -2.53, -0.27);
      slot.add(mp);
      const x = 0;
      const act = (object, action, enabled) => actionable(object, { module: index, ...action }, enabled);
      box(mp, [1.49, 0.065, 2.03], module.chaos ? '#5a4a3c' : '#505953', x, 2.56, 0.27);
      if (!module.chaos) cylinder(mp, 0.065, 0.025, module.solved ? '#49f58c' : '#18271e', x + 0.57, 2.61, -0.58, module.solved ? 1.8 : 0);
      for (const dx of [-0.63, 0.63]) for (const z of [-0.6, 1.12]) cylinder(mp, 0.035, 0.018, '#a3a797', x + dx, 2.604, z);
      if (module.type === 'wires') {
        const count = module.cut.length;
        module.cut.forEach((cut, i) => {
          const z = -0.34 + i * (1.31 / Math.max(1, count - 1));
          plate(mp, i + 1, 0.16, 0.16, x - 0.64, 2.62, z, '#f1ecd6', '#2b322e');
          const color = module.colors?.[i] ?? '#777777';
          const pieces = cut ? [[-0.31, 0.4], [0.31, 0.4]] : [[0, 1.02]];
          for (const [offset, length] of pieces) {
            const curve = new THREE.CatmullRomCurve3([
              new THREE.Vector3(x+.08+offset-length/2,2.67,z),
              new THREE.Vector3(x+.08+offset,2.75,z+.035),
              new THREE.Vector3(x+.08+offset+length/2,2.67,z)]);
            const wire = mesh(mp, new THREE.TubeGeometry(curve,12,.055,8,false),color,0,0,0);
            wire.material.roughness=.22;
            if(cut) for(let j=0;j<3;j++) sphere(mp,[.035,.018,.012],'#c99b60',x+.08+(offset<0?-.11:.11),2.67,z+(j-1)*.025);
            act(wire, { kind: 'cut', index: i }, !cut && !module.solved);
          }
          for (const dx of [-0.45, 0.61]) box(mp, [0.1, 0.11, 0.14], '#242b27', x + dx, 2.64, z);
        });
      } else if (module.type === 'button') {
        cylinder(mp, 0.57, 0.1, '#1c2421', x - 0.08, 2.66, 0.35);
        const y = module.holding ? 2.71 : 2.81;
        const button = cylinder(mp, 0.48, 0.2, module.color ?? '#777777', x - 0.08, y, 0.35);
        act(button, { kind: 'hold' }, !module.solved);
        if (module.label != null) {
          const label = plate(mp, module.label, 0.73, 0.23, x - 0.08, y + 0.102, 0.35, '#151a18', module.color ?? '#777777');
          // Labels share their button's hit target.
          label.object.userData.hitTarget = button;
          targets.push(label.object);
        }
        box(mp, [0.13, 0.055, 1.1], module.holding && module.strip ? module.strip : '#252b27', x + 0.58, 2.65, 0.32, module.holding && module.strip ? 1.2 : 0);
      } else if (module.type === 'keypad') {
        for (let i = 0; i < 4; i++) {
          const kx = x + (i % 2 ? 0.33 : -0.33), z = i < 2 ? 0.02 : 0.72;
          const pressed = module.pressed[i];
          const y = pressed ? 2.66 : 2.72;
          const key = box(mp, [0.56, 0.18, 0.57], pressed ? '#54ae76' : module.symbols == null ? '#777777' : '#b5b4a2', kx, y, z, pressed ? 0.4 : 0);
          act(key, { kind: 'press', index: i }, !pressed && !module.solved);
          if (module.symbols?.[i] != null) {
            const symbol = plate(mp, module.symbols[i], 0.47, 0.47, kx, y + 0.092, z, '#18251d', pressed ? '#54ae76' : '#b5b4a2');
            symbol.object.userData.hitTarget = key;
            targets.push(symbol.object);
          }
        }
      } else if (module.type === 'morse') {
        // Speaker, PLAY, three number dials and ENTER.
        cylinder(mp, 0.3, 0.05, '#1b201e', x - 0.35, 2.62, -0.25);
        for (let k = -2; k <= 2; k++) box(mp, [0.4 - Math.abs(k) * 0.08, 0.02, 0.04], '#0c0f0e', x - 0.35, 2.655, -0.25 + k * 0.1);
        const play = cylinder(mp, 0.17, 0.12, '#d8463a', x + 0.35, 2.66, -0.25);
        act(play, { kind: 'play' }, !module.solved);
        const playLabel = plate(mp, '▶', 0.2, 0.2, x + 0.35, 2.725, -0.25, '#fff4e0', '#d8463a');
        playLabel.object.userData.hitTarget = play;
        targets.push(playLabel.object);
        module.dials.forEach((d, k) => {
          const dial = cylinder(mp, 0.19, 0.14, '#c9c4b0', x + (k - 1) * 0.45, 2.67, 0.5);
          act(dial, { kind: 'dial', index: k }, !module.solved);
          const num = plate(mp, d, 0.24, 0.24, x + (k - 1) * 0.45, 2.745, 0.5, '#1d2320', '#c9c4b0');
          num.object.userData.hitTarget = dial;
          targets.push(num.object);
        });
        const enter = box(mp, [0.95, 0.12, 0.26], '#3f6f9e', x, 2.65, 1.0);
        act(enter, { kind: 'enter' }, !module.solved);
        const enterLabel = plate(mp, 'ENTER', 0.6, 0.16, x, 2.715, 1.0, '#eef4ff', '#3f6f9e');
        enterLabel.object.userData.hitTarget = enter;
        targets.push(enterLabel.object);
      } else if (module.type === 'arrows') {
        // Color light (sighted), Braille plate (Blind only), a D-pad and stage lights.
        const light = sphere(mp, [0.16, 0.16, 0.16], module.light ?? '#3a3d3b', x - 0.42, 2.68, -0.3);
        if (module.light) shine(light);
        box(mp, [0.44, 0.05, 0.58], '#bdb59a', x + 0.33, 2.61, -0.3);
        brailleDots(mp, module.braille, x + 0.33, 2.63, -0.3);
        const dirs = [[0, -0.3, '↑'], [0.3, 0, '→'], [0, 0.3, '↓'], [-0.3, 0, '←']];
        dirs.forEach(([dx, dz, glyph], k) => {
          const key = box(mp, [0.25, 0.13, 0.25], '#d7d2be', x + dx, 2.65, 0.62 + dz);
          act(key, { kind: 'dir', index: k }, !module.solved);
          const label = plate(mp, glyph, 0.2, 0.2, x + dx, 2.72, 0.62 + dz, '#1d2320', '#d7d2be');
          label.object.userData.hitTarget = key;
          targets.push(label.object);
        });
        for (let k = 0; k < 3; k++) cylinder(mp, 0.055, 0.03, k < module.stage ? '#49f58c' : '#18271e', x - 0.55, 2.62, 0.35 + k * 0.25, k < module.stage ? 1.5 : 0);
      } else if (module.type === 'switches') {
        // Four toggles, left to right: colored light above, Braille digit below, ENTER at the front.
        module.up.forEach((up, k) => {
          const sx = x + (k - 1.5) * 0.33;
          const light = sphere(mp, [0.09, 0.09, 0.09], module.lights?.[k] ?? '#3a3d3b', sx, 2.65, -0.42);
          if (module.lights) shine(light);
          box(mp, [0.2, 0.06, 0.34], '#1c2421', sx, 2.62, 0.08);
          const lever = new THREE.Group();
          lever.position.set(sx, 2.64, 0.08);
          lever.rotation.x = up ? -0.55 : 0.55;
          mp.add(lever);
          const stick = cylinder(lever, 0.04, 0.3, '#d8d2bd', 0, 0.15, 0);
          sphere(lever, [0.07, 0.07, 0.07], '#e9e4d0', 0, 0.31, 0);
          act(stick, { kind: 'flip', index: k }, !module.solved);
          lever.children[1].userData.hitTarget = stick; targets.push(lever.children[1]);
          box(mp, [0.24, 0.04, 0.3], '#bdb59a', sx, 2.61, 0.55);
          if (module.braille) brailleDots(mp, module.braille[k], sx, 2.63, 0.55, 0.45);
        });
        enterKey(mp, act, x, 1.02, !module.solved);
      } else if (module.type === 'piano') {
        // Light and Braille at the back, progress lights, then five numbered keys.
        const light = sphere(mp, [0.13, 0.13, 0.13], module.light ?? '#3a3d3b', x - 0.42, 2.67, -0.42);
        if (module.light) shine(light);
        box(mp, [0.4, 0.05, 0.4], '#bdb59a', x + 0.22, 2.61, -0.4);
        if (module.braille) brailleDots(mp, module.braille, x + 0.22, 2.63, -0.4, 0.8);
        for (let k = 0; k < 4; k++) cylinder(mp, 0.045, 0.03, k < module.progress ? '#49f58c' : '#18271e', x - 0.3 + k * 0.2, 2.62, -0.1, k < module.progress ? 1.5 : 0);
        for (let k = 0; k < 5; k++) {
          const kx = x + (k - 2) * 0.27;
          const key = box(mp, [0.24, 0.14, 1.0], '#f4f1e6', kx, 2.65, 0.6);
          act(key, { kind: 'key', index: k }, !module.solved);
          const num = plate(mp, k + 1, 0.16, 0.16, kx, 2.725, 0.95, '#2a2620', '#f4f1e6');
          num.object.userData.hitTarget = key; targets.push(num.object);
          if (k < 4) box(mp, [0.13, 0.12, 0.55], '#1c1f1e', kx + 0.135, 2.72, 0.33);
        }
      } else if (module.type === 'calculator') {
        // Screen with the sum (sighted only), a light, the typed number, and a 3x4 keypad.
        plate(mp, module.expr ?? '', 0.95, 0.3, x - 0.15, 2.62, -0.5, '#9dffb8', '#0d1a12');
        const light = sphere(mp, [0.1, 0.1, 0.1], module.light ?? '#3a3d3b', x + 0.5, 2.66, -0.27);
        if (module.light) shine(light);
        plate(mp, module.typed || '—', 0.6, 0.2, x, 2.62, -0.17, '#f3efe2', '#262a27');
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⏎'];
        keys.forEach((label, k) => {
          const kx = x + (k % 3 - 1) * 0.36, kz = 0.15 + Math.floor(k / 3) * 0.29;
          const action = label === 'C' ? { kind: 'clear' } : label === '⏎' ? { kind: 'enter' } : { kind: 'digit', index: Number(label) };
          const color = label === '⏎' ? '#3f6f9e' : label === 'C' ? '#b5584a' : '#d7d2be';
          const key = box(mp, [0.3, 0.1, 0.24], color, kx, 2.64, kz);
          act(key, action, !module.solved);
          const text = plate(mp, label, 0.18, 0.18, kx, 2.695, kz, label === '⏎' || label === 'C' ? '#fff4e8' : '#1d2320', color);
          text.object.userData.hitTarget = key; targets.push(text.object);
        });
      } else if (module.type === 'flashes') {
        // Four buttons in a diamond (up, right, down, left). Sighted monkeys see their colors
        // and the looping flash sequence; Blind feels a Braille digit on each.
        const buttons = [[0, -0.42], [0.42, 0], [0, 0.42], [-0.42, 0]].map(([dx, dz], k) => {
          const bx = x + dx, bz = 0.4 + dz;
          const button = cylinder(mp, 0.2, 0.1, module.colors?.[k] ?? '#b5b4a2', bx, 2.65, bz);
          act(button, { kind: 'press', index: k }, !module.solved);
          if (module.braille) brailleDots(mp, module.braille[k], bx, 2.69, bz, 0.5).forEach((d) => { d.userData.hitTarget = button; targets.push(d); });
          return button;
        });
        if (module.sequence) flashers.push({ buttons, sequence: module.sequence });
        for (let k = 0; k < 3; k++) cylinder(mp, 0.05, 0.03, k < module.progress ? '#49f58c' : '#18271e', x + (k - 1) * 0.16, 2.62, -0.56, k < module.progress ? 1.5 : 0);
      } else if (module.type === 'soundboard') {
        // A 3x3 grid of latching buttons, each with a Braille digit; light and ENTER on the right.
        module.latched.forEach((on, k) => {
          const bx = x - 0.22 + (k % 3 - 1) * 0.34, bz = 0.1 + Math.floor(k / 3) * 0.4;
          const y = on ? 2.63 : 2.68;
          const button = box(mp, [0.3, 0.1, 0.34], on ? '#e0b84a' : '#b5b4a2', bx, y, bz, on ? 0.3 : 0);
          act(button, { kind: 'tap', index: k }, !module.solved);
          if (module.braille) brailleDots(mp, module.braille[k], bx, y + 0.05, bz, 0.45).forEach((d) => { d.userData.hitTarget = button; targets.push(d); });
        });
        const light = sphere(mp, [0.11, 0.11, 0.11], module.light ?? '#3a3d3b', x + 0.5, 2.66, -0.2);
        if (module.light) shine(light);
        const enter = box(mp, [0.3, 0.12, 0.75], '#3f6f9e', x + 0.5, 2.65, 0.55);
        act(enter, { kind: 'enter' }, !module.solved);
      } else if (module.type === 'slider') {
        // Chaos: a knob on a track that keeps rising toward the red zone.
        box(mp, [0.16, 0.05, 1.55], '#16191a', x, 2.61, 0.3);
        box(mp, [0.3, 0.06, 0.3], '#c23b30', x, 2.615, -0.42, 0.6);
        plate(mp, 'CHAOS', 0.5, 0.14, x - 0.45, 2.62, 1.12, '#f6d8b0', '#5a4a3c');
        sliderKnob = box(mp, [0.46, 0.2, 0.22], '#e9e4d0', x, 2.7, 0.3);
        act(sliderKnob, { kind: 'push' }, true);
      }
    });
    if (state.game.role.touch && !state.game.role.seeBomb) outline(bomb);
    // Only the case itself needs a shadow on the table, not every little part on it.
    bomb.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingSphere(); o.castShadow = o.geometry.boundingSphere.radius * o.getWorldScale(tmpScale).x > .45; } });
  }

  function buildMonkeys(players, you) {
    if (selfMonkey) { destroy(selfMonkey.root); selfMonkey = null; }
    if (state?.game) {
      selfMonkey = createMonkey({ name: "", role: state.game.role.id, firstPerson: true });
      selfMonkey.setReading(reading);
      camera.add(selfMonkey.root);
    } else localEmote = null;
    destroy(monkeys);
    monkeys = new THREE.Group();
    scene.add(monkeys);
    monkeyRecords = [];
    players.forEach((player, index) => {
      if (player.id === you && state?.game) return;
      const seat = seats[seatIndex(player, index, players)];
      const monkey = createMonkey({ name: player.name, role: state?.game ? player.role : null });
      monkey.root.position.set(seat[0], seat[3], seat[1]);
      // In the lobby everyone turns round to face the camera.
      monkey.root.rotation.y = state?.game ? seat[2] : Math.atan2(-seat[0], 3.45 - seat[1]);
      monkey.root.scale.setScalar(0.79);
      monkeys.add(monkey.root);
      monkeyRecords.push({ player, monkey });
    });
  }

  function drawTimer(value) {
    if (!timer) return;
    const ctx = timer.context;
    ctx.fillStyle = '#100e0c';
    ctx.fillRect(0, 0, 512, 192);
    if (value == null) {
      timer.draw('?:??', '#3f4140', '#100e0c');
      return;
    }
    const digits = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
    const segments = { a: [12, 0, 48, 10], b: [60, 10, 10, 59], c: [60, 80, 10, 59], d: [12, 139, 48, 10], e: [2, 80, 10, 59], f: [2, 10, 10, 59], g: [12, 70, 48, 10] };
    const str = String(value), step = Math.min(85, 470 / str.length);
    let x = (512 - step * str.length) / 2;
    for (const char of str) {
      if (char === ':') {
        ctx.fillStyle = '#4dff7a';
        ctx.fillRect(x + 30, 63, 10, 10);
        ctx.fillRect(x + 30, 113, 10, 10);
      } else for (const [name, rect] of Object.entries(segments)) {
        ctx.fillStyle = digits[char]?.includes(name) ? '#4dff7a' : '#10301a';
        ctx.fillRect(x + rect[0] * step / 85, 22 + rect[1], rect[2] * step / 85, rect[3]);
      }
      x += step;
    }
    timer.texture.needsUpdate = true;
  }

  function update(next) {
    if (disposed) return;
    const previousStatus = state?.game?.status;
    state = next;
    receivedAt = performance.now();
    const game = state?.game;
    if (game?.status !== previousStatus && ['won','lost'].includes(game?.status)) { effectAt=receivedAt; burst(game.status==='lost'); if(game.status==='lost') flashAt=receivedAt; }
    if (!canTouch()) held = false;
    const bombShape = game?.bomb && { ...game.bomb, modules: game.bomb.modules.map((m) => (m.type === 'slider' ? { type: 'slider' } : m)) };
    const signature = JSON.stringify([!!game, game?.role.id, game?.status, bombShape]);
    if (signature !== bombSignature) {
      bombSignature = signature;
      buildBomb(game?.bomb);
    }
    drawTimer(game?.timer);
    const slider = game?.bomb?.modules.find((m) => m.type === 'slider');
    if (sliderKnob && slider) sliderKnob.position.z = 0.95 - slider.value * 1.3;
    strikeLights.forEach((light, index) => {
      if (!light.material.emissive) return; // Blind sees outlines only
      const lit = index < game.strikes;
      light.material.color.set(lit ? '#ff3d24' : '#321916');
      light.material.emissive.set(lit ? '#ff3d24' : '#000000');
      light.material.emissiveIntensity = lit ? 2 : 0;
    });
    const playersKey = JSON.stringify([!!game, state?.you, (state?.players || []).map((p) => [p.id, p.name, p.role])]);
    if (playersKey !== playersSignature) {
      playersSignature = playersKey;
      buildMonkeys(state?.players || [], state?.you);
    }
    for (const { player, monkey } of monkeyRecords) {
      const headLook = headLooks.get(player.id);
      monkey.setLook(state?.game && headLook ? headLook : null);
      // Records keep the player from when the monkey was built; read live flags from the state.
      monkey.setReading(!!state?.game && !!state.players.find((p) => p.id === player.id)?.reading);
      const emote = (game?.emotes || []).filter((item) => item.age < 5000 && item.id === player.id).at(-1);
      if (emote?.aim) bananaAims.set(player.id, emote.aim);
      monkey.setEmote(emote?.e ?? null, emote?.age ?? 0);
      monkey.setTalking((state.speaking || []).includes(player.id));
    }
    if (selfMonkey) {
      let own = state.myEmote;
      for (const item of game?.emotes || []) if (item.id === state.you && item.age < 5000) own = item;
      // Blind's state carries no emotes, so their own throw uses where they look right now.
      bananaAims.set(state.you, own?.aim ?? myAim);
      if (own) selfMonkey.setEmote(own.e, own.age ?? 0, receivedAt);
      else if (localEmote && receivedAt - localEmoteAt < 5000) selfMonkey.setEmote(localEmote, receivedAt - localEmoteAt, receivedAt);
      else selfMonkey.setEmote(null, 0, receivedAt);
    }
    const blind = !!game && !game.role.seeBomb && game.role.touch;
    vignette.style.opacity = blind ? '.6' : '0';
    renderer.toneMappingExposure = blind ? 1.15 : 1.25;
    ambient.intensity = blind ? 2.4 : 2.2;
    lamp.color.set(game?.status === 'won' ? '#8bffb3' : '#ffbc72');
    lamp.intensity = blind ? 75 : game?.status === 'won' ? 125 : 90;
    fill.intensity = blind ? 0 : 35;
    monkeys.visible = !blind;
    flyingBananas.visible = !blind;
    room.visible = !blind; outside.visible = !blind;
    scene.background.set(blind ? '#000000' : '#a9dded');
    sun.intensity=blind?1.5:3;
  }
  // Blind's server state omits emotes. Mirror the existing wheel locally.
  function ownGesture(event) {
    const button = event.target.closest?.('#emote-wheel button[data-emote]');
    if (!button || state?.game?.status !== 'playing' || !selfMonkey) return;
    localEmote = button.dataset.emote;
    localEmoteAt = performance.now();
    selfMonkey.setEmote(localEmote, 0, localEmoteAt);
  }
  document.addEventListener('click', ownGesture);
  function canTouch() { return state?.game?.status === 'playing' && state.game.role.touch; }
  const lastHit = new THREE.Vector3();
  // Blind "feels" Braille: with the finger on a cell, its number pops up next to the cursor.
  const brailleLabel = document.createElement('div');
  Object.assign(brailleLabel.style, { position: 'absolute', pointerEvents: 'none', display: 'none', font: '800 64px system-ui, sans-serif', color: '#ffffff', textShadow: '0 0 12px #fff8, 0 2px 0 #000', transform: 'translate(-50%, -120%)' });
  container.appendChild(brailleLabel);
  function readBraille() {
    let digit = null;
    if (canTouch() && !state.game.role.seeBomb && brailleTouch.length) {
      raycaster.setFromCamera(pointer, camera);
      digit = raycaster.intersectObjects(brailleTouch, false)[0]?.object.userData.brailleDigit ?? null;
    }
    brailleLabel.style.display = digit ? 'block' : 'none';
    if (digit) {
      brailleLabel.textContent = digit;
      brailleLabel.style.left = `${(pointer.x + 1) / 2 * 100}%`;
      brailleLabel.style.top = `${(1 - pointer.y) / 2 * 100}%`;
    }
  }
  function pick() {
    if (!canTouch()) return null;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(targets, false)) {
      const target = hit.object.userData.hitTarget || hit.object;
      if (target.userData.action) { lastHit.copy(hit.point); return target; }
    }
    return null;
  }
  // Shift locks the cursor: it disappears, a crosshair sits in the middle, the mouse turns
  // your head, and clicks land on whatever the crosshair is over.
  const locked = () => document.pointerLockElement === canvas;
  const crosshair = document.createElement('div');
  crosshair.className = 'crosshair hidden';
  container.appendChild(crosshair);
  // Nobody gets the locked cursor while leaned in over the bomb.
  const blindZoomed = () => !!state?.game && leaning;
  function toggleLock() {
    if (locked()) document.exitPointerLock();
    else if (state?.game && !blindZoomed() && !cursorOverlays.size) canvas.requestPointerLock?.()?.catch?.(() => {});
  }
  document.addEventListener('pointerlockchange', () => {
    const on = locked();
    crosshair.classList.toggle('hidden', !on);
    if (on) pointer.set(0, 0);
    else {
      // Hold the current view while the free cursor is back (wheel, manual, Esc); the first
      // mouse move then carries on from here instead of jumping to the cursor's position.
      pointer.set(0, 0);
      lookOffset.copy(mouseLook);
      rebase = true;
    }
  });
  const cursorOverlays = new Set();
  let resumeLock = false;
  function setCursorOverlay(name, open) {
    if (cursorOverlays.has(name) === open) return;
    if (open) {
      cursorOverlays.add(name);
      if (locked()) { resumeLock = true; document.exitPointerLock(); }
    } else {
      cursorOverlays.delete(name);
      if (!cursorOverlays.size) {
        rebase = true;
        if (resumeLock && state?.game && !blindZoomed()) canvas.requestPointerLock?.()?.catch?.(() => {});
        resumeLock = false;
      }
    }
  }
  function lockKey(event) {
    if (event.repeat || event.target.closest?.('input, textarea, select')) return;
    if (event.key === 'Shift' && !cursorOverlays.size) toggleLock();
  }
  window.addEventListener('keydown', lockKey);
  function move(event) {
    if (cursorOverlays.size) return;
    if (locked()) {
      mouseLook.x = THREE.MathUtils.clamp(mouseLook.x + event.movementX * 0.0022 * lookSpeed, -1.4, 1.4);
      mouseLook.y = THREE.MathUtils.clamp(mouseLook.y - event.movementY * 0.0022 * lookSpeed, -1.4, 1.4);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 2 - 1, y = -(event.clientY - rect.top) / rect.height * 2 + 1;
    if (rebase) {
      // Back from the gesture wheel or another overlay: carry on from the current view
      // instead of jumping to wherever the cursor now is.
      rebase = false;
      lookOffset.set(mouseLook.x - x * lookSpeed, mouseLook.y - y * lookSpeed);
    } else if (Math.abs(pointer.x) <= 1) {
      // The offset fades as the mouse moves, back to "screen edge = 90 degrees".
      lookOffset.multiplyScalar(Math.exp(-Math.hypot(x - pointer.x, y - pointer.y) * 0.8));
    }
    pointer.set(x, y);
  }
  function down(event) {
    if (event.button === 2) { event.preventDefault(); toggleLean(); return; }
    if (event.button !== 0 || held) return;
    if (!locked()) move(event);
    const target = pick();
    if (!target) return;
    event.preventDefault();
    if (target.userData.action.kind === 'hold') { held = true; heldModule = target.userData.action.module; }
    onAct({ ...target.userData.action, at: lastHit.toArray().map((v) => +v.toFixed(3)) });
  }
  // Blind needs the bomb centered because their free cursor only touches the controls.
  function toggleLean() {
    leaning = !leaning;
    if (leaning && locked()) document.exitPointerLock();
    if (leaning && state?.game?.role.touch && !state.game.role.seeBomb) {
      resetLook();
      keyTurn = 0;
      keyTilt = 0;
    }
    rebase = true;
  }
  function release() {
    if (!held) return;
    held = false;
    if (canTouch()) onAct({ module: heldModule, kind: 'release' });
  }
  // Overlays like the gesture wheel sit on top of the canvas: keep looking where you were.
  function leave() { rebase = true; }
  function resetLook() { pointer.set(9, 9); lookOffset.set(0, 0); mouseLook.set(0, 0); rebase = true; }
  // A/D or the arrow keys turn the head; held keys turn it all the way.
  const keysDown = new Set();
  let reading = false, rebase = false, myAim = [0, 0];
  const bananaAims = new Map();
  const lookOffset = new THREE.Vector2(), mouseLook = new THREE.Vector2();
  let keyTurn = 0, keyTilt = 0, lookSentAt = 0, sentLook = [9, 9];
  const headLooks = new Map();
  const TURN_KEYS = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down' };
  function turnKey(event) {
    const dir = TURN_KEYS[event.code];
    if (!dir || event.target.closest?.('input, textarea, select')) return;
    if (event.type === 'keydown') keysDown.add(dir); else keysDown.delete(dir);
  }
  window.addEventListener('keydown', turnKey);
  window.addEventListener('keyup', turnKey);
  window.addEventListener('blur', () => keysDown.clear());
  function key(event) {
    if (event.code !== 'Space' || event.repeat || event.target.closest?.('input, textarea, select, button, [contenteditable="true"]')) return;
    event.preventDefault();
    toggleLean();
  }
  function context(event) { event.preventDefault(); }
  function resize() {
    const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('contextmenu', context);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  window.addEventListener('keydown', key);
  function animate(now) {
    if (disposed) return;
    adaptQuality(now, now - lastFrame);
    // Shadows only redraw every other frame; at 60 fps nobody can tell.
    renderer.shadowMap.needsUpdate = (shadowFrame = !shadowFrame);
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    // Whoever handles the bomb gets a steady camera so the parts don't slide away from the
    // cursor; they turn with the keys. Everyone else also looks with the mouse.
    const turnGoal = (keysDown.has('right') ? 1 : 0) - (keysDown.has('left') ? 1 : 0);
    const tiltGoal = (keysDown.has('up') ? 1 : 0) - (keysDown.has('down') ? 1 : 0);
    keyTurn += (turnGoal - keyTurn) * (1 - Math.exp(-dt * 4));
    keyTilt += (tiltGoal - keyTilt) * (1 - Math.exp(-dt * 4));
    if (locked() && blindZoomed()) document.exitPointerLock();
    if (locked()) pointer.set(0, 0);
    else if (!cursorOverlays.size && !rebase && Math.abs(pointer.x) <= 1 && !canTouch()) mouseLook.set(
      THREE.MathUtils.clamp(pointer.x * lookSpeed + lookOffset.x, -1.4, 1.4), THREE.MathUtils.clamp(pointer.y * lookSpeed + lookOffset.y, -1.4, 1.4));
    else if (!cursorOverlays.size && pointer.x === 9 && !canTouch()) mouseLook.set(0, 0);
    look.set(THREE.MathUtils.clamp(mouseLook.x + keyTurn * 1.4, -1.4, 1.4), THREE.MathUtils.clamp(mouseLook.y + keyTilt * 1.4, -1.4, 1.4));
    lastFrame = now;
    const role=state?.game?.role.id;
    const me=state?.players?.findIndex(p=>p.id===state.you) ?? 0;
    const mySeat=state?.players?.[me] ? seatIndex(state.players[me],me,state.players) : 0;
    // Each seat has a resting view and a lean-in view over the case.
    const views = [
      { at: [0, 2.15, 2.1], look: [0, 1.38, .5], lean: [0, 2.15, 1.45], leanLook: [0, 1.4, .55] },
      { at: [1.4, 2.2, 1.3], look: [.5, 1.75, -.15], lean: [.55, 2.1, 1.2], leanLook: [0, 1.35, .55] },
      { at: [1.0, 2.3, -2.1], look: [.6, 1.75, 1.2] },
      { at: [-1.5, 2.05, .6], look: [.4, 1.55, .1], lean: [-.55, 2.1, 1.2], leanLook: [0, 1.35, .55] },
    ];
    const view = views[mySeat];
    if (!state?.game) { goal.set(0, 3.0, 3.45); aim.set(0, 1.45, -.1); }
    else if (leaning && view.lean) { goal.set(...view.lean); aim.set(...view.leanLook); }
    else { goal.set(...view.at); aim.set(...view.look); }
    goal.x+=Math.sin(now*.0013)*.01;
    goal.y+=Math.sin(now*.003)*.008;
    // Look around by turning the head toward the cursor.
    // Turn up to 90 degrees left or right of the way the seat faces, never behind it.
    if (state?.game) {
      aim.sub(goal);
      const seatYaw = seats[mySeat][2], baseYaw = Math.atan2(aim.x, aim.z);
      const offset = Math.atan2(Math.sin(baseYaw - seatYaw), Math.cos(baseYaw - seatYaw));
      const yaw = THREE.MathUtils.clamp(offset - look.x * Math.PI / 2, -Math.PI / 2, Math.PI / 2);
      // Up and down: up to straight up or down, stopping just short so the camera can't flip.
      const basePitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
      const pitch = THREE.MathUtils.clamp(basePitch + look.y * Math.PI / 2, -1.45, 1.45);
      myAim = [+yaw.toFixed(3), +pitch.toFixed(3)];
      const facing = seatYaw + yaw, reach = aim.length();
      aim.set(Math.sin(facing) * Math.cos(pitch), Math.sin(pitch), Math.cos(facing) * Math.cos(pitch)).multiplyScalar(reach).add(goal);
      // Teammates see your monkey's head follow your view; send changes ~10 times a second.
      if (now - lookSentAt > 100 && (Math.abs(yaw - sentLook[0]) > .03 || Math.abs(pitch - sentLook[1]) > .03)) {
        lookSentAt = now; sentLook = [yaw, pitch];
        onLook(+yaw.toFixed(3), +pitch.toFixed(3));
      }
    }
    // Cut straight to a new seat instead of flying through the van's seats.
    const key = `${!!state?.game}:${role}:${mySeat}`;
    // A new round (or seat) starts looking straight ahead, wherever the mouse was in the lobby.
    if (key !== seatKey) { seatKey = key; resetLook(); camera.position.copy(goal); smoothAim.copy(aim); }
    camera.position.lerp(goal,1-Math.exp(-dt*5));
    smoothAim.lerp(aim,1-Math.exp(-dt*5)); camera.lookAt(smoothAim);
    hangingPlant.rotation.z=Math.sin(now*.0019)*.035;
    hangingPlant.rotation.x=Math.sin(now*.0013)*.025;
    for(const {batch,pieces,speed} of scenery) {
      pieces.forEach((piece,i) => {
        piece.at[2]+=dt*speed;
        if(piece.at[2]>26) piece.at[2]-=96;
        detailTransform.position.set(...piece.at);
        // Hide anything passing under the van, like the centre-line markings.
        const under = Math.abs(piece.at[0]) < 2.45 && Math.abs(piece.at[2]) < 4.2;
        detailTransform.scale.set(...piece.size).multiplyScalar(under ? 0 : 1);
        detailTransform.updateMatrix();
        batch.setMatrixAt(i,detailTransform.matrix);
      });
      batch.instanceMatrix.needsUpdate=true;
    }
    for(const part of [...particles.children]) {
      const age=(now-part.userData.born)/1000;
      if(age>4) {destroy(part);continue;}
      part.position.addScaledVector(part.userData.velocity,dt);
      part.userData.velocity.y-=dt*(part.userData.smoke?.2:2);
      part.material.opacity=1-age/4;
      if(part.userData.smoke) part.scale.multiplyScalar(1+dt*.5);
      else part.rotation.x+=dt*3;
    }
    const target = pick();
    readBraille();
    if (hovering !== target) {
      const glow = (o, on) => {
        if (o.userData.edges) o.userData.edges.material.color.set(on ? '#ffd84d' : '#f4f4f4');
        else o.material.emissiveIntensity = on ? 0.65 : o.userData.baseGlow;
      };
      if (hovering) glow(hovering, false);
      hovering = target;
      crosshair.classList.toggle('on', !!target);
      if (hovering) glow(hovering, true);
      canvas.style.cursor = hovering ? 'pointer' : 'default';
    }
    for (const { monkey, player } of monkeyRecords) {
      monkey.update(now, dt, camera);
      const t = monkey.takeThrow();
      if (t) launchBanana(monkey, player.id, t);
    }
    if (selfMonkey) {
      selfMonkey.update(now, dt, camera);
      const h = renderer.domElement.clientHeight || innerHeight, page = Math.max(0, h - 184);
      selfMonkey.setBookFrame(page / h, (80 + page / 2) / h);
      const t = selfMonkey.takeThrow();
      if (t) launchBanana(selfMonkey, state.you, t);
    }
    stepBananas(now);
    stepFlashers(now);
    const flash = Math.max(0, 1 - (now - flashAt) / 1100);
    if (flash > 0) {
      lamp.color.set('#ff4816');
      lamp.intensity = 90 + flash * 400;
    } else if (state?.game?.status === 'lost') {
      lamp.color.set('#ffbc72');
      lamp.intensity = state.game.role.touch && !state.game.role.seeBomb ? 30 : 90;
    }
    if(flash>0) {camera.position.x+=Math.sin(now*.08)*flash*.09; renderer.setClearColor('#ffffff');}
    vignette.style.backgroundColor=flash>0?`rgba(255,255,255,${flash*.8})`:'transparent';
    if(flash>0) vignette.style.opacity='1';
    if (lowQuality) renderer.render(scene, camera); else composer.render();
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  function screenTargets() {
    scene.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect(), v = new THREE.Vector3();
    return targets.filter((t) => t.userData.action).map((t) => {
      if (!t.geometry.boundingBox) t.geometry.computeBoundingBox();
      t.geometry.boundingBox.getCenter(v).applyMatrix4(t.matrixWorld).project(camera);
      return { action: t.userData.action, x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
    });
  }
  // Graphics levels, best first. Auto starts in the middle and steps down whenever frames
  // run slow (a MacBook Air's integrated GPU, a hot laptop) and back up when there's room.
  const LEVELS = [
    { dpr: 1.5, bloom: true, shadows: true },
    { dpr: 1.25, bloom: true, shadows: true },
    { dpr: 1, bloom: true, shadows: true },
    { dpr: 1, bloom: false, shadows: true },
    { dpr: 0.85, bloom: false, shadows: false },
    { dpr: 0.7, bloom: false, shadows: false },
  ];
  let shadowFrame = false;
  renderer.shadowMap.autoUpdate = false;
  let qualityMode = 'auto', level = 2, frameAvg = 16, judgedAt = 0, steadyFor = 0;
  function applyLevel(i) {
    level = THREE.MathUtils.clamp(i, 0, LEVELS.length - 1);
    const { dpr, bloom, shadows } = LEVELS[level];
    lowQuality = !bloom;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dpr));
    if (renderer.shadowMap.enabled !== shadows) {
      renderer.shadowMap.enabled = shadows;
      scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
    resize();
  }
  function setQuality(quality) {
    qualityMode = quality;
    applyLevel(quality === 'high' ? 0 : quality === 'low' ? 4 : 2);
  }
  function adaptQuality(now, frameMs) {
    if (qualityMode !== 'auto' || document.hidden || frameMs > 250) return;
    frameAvg += (frameMs - frameAvg) * 0.05;
    if (now - judgedAt < 1500) return;
    judgedAt = now;
    // Below ~45 fps: drop a level. Comfortably above 58 fps for a while: try one up.
    if (frameAvg > 22) { applyLevel(level + 1); steadyFor = 0; }
    else if (frameAvg < 17.5 && ++steadyFor >= 4 && level > 0) { applyLevel(level - 1); steadyFor = 0; frameAvg = 20; }
  }
  return {
    update,
    setQuality,
    reach: (id, at, hold) => {
      const record = monkeyRecords.find((r) => r.player.id === id);
      if (record) record.monkey.reach(at && new THREE.Vector3(...at), hold);
    },
    setHeadLook: (id, yaw, pitch) => headLooks.set(id, [yaw, pitch]),
    setReading: (on) => { reading = on; selfMonkey?.setReading(on); },
    // Opening the manual looks back to the resting view.
    resetLook,
    setCursorOverlay,
    aim: () => myAim,
    setLookSpeed: (v) => { lookSpeed = v; },
    screenTargets,
    // Test hook: where each Braille cell is on screen, and its digit.
    braillePads: () => brailleTouch.map((pad) => {
      const v = pad.getWorldPosition(new THREE.Vector3()).project(camera), rect = canvas.getBoundingClientRect();
      return { digit: pad.userData.brailleDigit, x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
    }),
    // Test hook: drawn meshes and shadow casters per top-level group, plus GPU calls per frame.
    breakdown: () => {
      const out = {};
      for (const [name, g] of Object.entries({ room, outside, bomb, monkeys, self: selfMonkey?.root, flyingBananas })) {
        let meshes = 0, shadow = 0, tris = 0;
        g?.traverse((o) => { if (o.isMesh && o.visible) { meshes++; if (o.castShadow) shadow++; tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.count ?? 1); } });
        out[name] = { meshes, shadow, tris: Math.round(tris) };
      }
      renderer.info.autoReset = false; renderer.info.reset();
      if (lowQuality) renderer.render(scene, camera); else composer.render();
      out.calls = renderer.info.render.calls; out.triangles = renderer.info.render.triangles;
      renderer.info.autoReset = true;
      return out;
    },
    stats: () => { let meshes = 0, shadow = 0; scene.traverse((o) => { if (o.isMesh && o.visible) { meshes++; if (o.castShadow) shadow++; } }); return { ...renderer.info.render, meshes, shadow, launched, bananas: flyingBananas.children.map((b) => b.position.toArray().map((v) => +v.toFixed(2))) }; },
    dispose() {
      if (disposed) return;
      release();
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('contextmenu', context);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
      window.removeEventListener('keydown', key);
      window.removeEventListener('keydown', turnKey);
      window.removeEventListener('keydown', lockKey);
      window.removeEventListener('keyup', turnKey);
      document.removeEventListener('click', ownGesture);
      destroy(scene);
      bloom.dispose(); outputPass.dispose(); renderPass.dispose(); composer.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      canvas.remove();
      vignette.remove();
    },
  };
}
