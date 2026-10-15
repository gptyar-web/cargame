import * as THREE from '../../vendor/three.module.js';
import { CARS, getCar } from '../cars.js';
import { createWorld, CITY_HALF } from './world.js';
import { createVehicle, updateVehicle, disposeVehicle } from './vehicle.js';
import { GameAudio } from './audio.js';
import { createTraffic } from './traffic.js';
import { createCollectibles, createDrivingEffects } from './effects.js';
import { createRadar } from './radar.js';
import { createCoinAutopilot } from './autopilot.js';

const $ = selector => document.querySelector(selector);
const mount = $('#game');
if (!mount) throw new Error('محل نمایش بازی پیدا نشد.');
THREE.ColorManagement.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc0afb0);
scene.fog = new THREE.Fog(0xc0afb0, 90, 290);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, .1, 1100);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
const debugRenderer = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
const gpuName = debugRenderer ? renderer.getContext().getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL) : '';
const softwareRenderer = /swiftshader|llvmpipe|software/i.test(gpuName);
// Render scale supplies supersampling on GPUs, without costly multisample buffers in software.
renderer.setPixelRatio(softwareRenderer ? .5 : Math.min(Math.max(devicePixelRatio || 1, 1.25), 1.65));
renderer.setSize(innerWidth, innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = !softwareRenderer;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.setAttribute('aria-label','شهر سه‌بعدی و ماشین انتخاب‌شده');
mount.replaceChildren(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xcbe2ee,0x8b7463,1.25));
const sun = new THREE.DirectionalLight(0xffd6a5,2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024,1024);
Object.assign(sun.shadow.camera,{left:-70,right:70,top:70,bottom:-70,near:1,far:290});
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.normalBias=.04;
sun.shadow.bias=-.0002;
scene.add(sun,sun.target);

// A shader sky supplies a warm horizon without remote HDR or image dependencies.
const sky = new THREE.Mesh(new THREE.SphereGeometry(900,24,16), new THREE.ShaderMaterial({
  side:THREE.BackSide, depthWrite:false,
  uniforms:{top:{value:new THREE.Color(0x789ebc)},bottom:{value:new THREE.Color(0xf1c29e)}},
  vertexShader:'varying vec3 vPosition; void main(){ vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader:'uniform vec3 top; uniform vec3 bottom; varying vec3 vPosition; void main(){ float h=normalize(vPosition).y; gl_FragColor=vec4(mix(bottom,top,smoothstep(-0.08,0.8,h)),1.0);\n#include <tonemapping_fragment>\n#include <encodings_fragment>\n}',
}));
scene.add(sky);
const world=createWorld(scene, { lowQuality: softwareRenderer });
const state={x:3.5,z:54,heading:0,speed:0,steering:0,wheelSpin:0,driftAngle:0,fuel:100,signal:null,lights:true};
const progress={coins:0,score:0,level:1,collisionCooldown:0};
const keys={up:false,down:false,left:false,right:false,handbrake:false,refuel:false};
let selected=getCar(CARS[0].id);
let car=createVehicle(selected);
scene.add(car);
let started=false,cameraMode=0,refueling=false,blink=false,blinkTimer=0,toastTimer=0,refuelSoundTimer=0,renderFrames=3;
const soundButton=$('#soundButton');
const audio=new GameAudio(muted=>{
  if(soundButton) {soundButton.textContent=muted?'صدا خاموش':'صدا روشن';soundButton.setAttribute('aria-pressed',String(muted));}
  dispatchEvent(new CustomEvent('game-sound',{detail:{muted}}));
});
const traffic=createTraffic(scene,state,()=>progress.level, { lowQuality: softwareRenderer });
const collectibles=createCollectibles(scene,state,()=>{
  progress.coins++;
  let reward=100;
  const nextLevel=Math.floor(progress.coins/10)+1;
  if(nextLevel>progress.level) {
    progress.level=nextLevel;
    reward+=500*progress.level;
    showToast(`مرحله ${progress.level}`,'شهر منتظر رکورد تازهٔ توست');
    audio.levelUp();
  } else audio.coin();
  progress.score+=reward;
  dispatchEvent(new CustomEvent('game-progress',{detail:{coinsDelta:1,scoreDelta:reward}}));
  updateHud();
});
const effects=createDrivingEffects(scene,state);
const drawRadar=createRadar($('#radarCanvas'),state,world,traffic,collectibles);
const controlButtons=[...document.querySelectorAll('[data-control]')];
const autopilot=createCoinAutopilot();
let autoDriving=false;
const setText=(id,value)=>{const el=$(`#${id}`);if(el)el.textContent=String(value);};
function setAutoDriving(enabled) {
  autoDriving=!!enabled&&started;
  autopilot.reset();
  if(autoDriving)clearInputs();
  const button=$('#autoDriveButton');
  if(button) {
    button.disabled=!started;
    button.setAttribute('aria-pressed',String(autoDriving));
    button.setAttribute('aria-label',autoDriving?'غیرفعال‌سازی رانندگی خودکار':'فعال‌سازی رانندگی خودکار برای جمع‌آوری سکه‌ها');
    button.textContent=autoDriving?'خودکار ✓':'خودکار';
    button.title=autoDriving?'توقف حالت جمع‌آوری خودکار سکه‌ها':'حرکت خودکار با بیشترین سرعت امن برای جمع‌آوری سکه‌ها';
  }
}


function showToast(title,message) {
  const toast=$('#levelToast');
  if(!toast)return;
  const strong=toast.querySelector('strong'),span=toast.querySelector('span');
  if(strong)strong.textContent=title;
  if(span)span.textContent=message;
  toast.classList.add('show');toastTimer=3;
}
function nearbyStation() {
  return world.stations.find(station=>Math.hypot(state.x-station.x,state.z-station.z)<=station.radius);
}
function updateHud() {
  setText('speed',Math.round(Math.abs(state.speed)*3.6));
  setText('speedMax',selected.maxSpeed);
  setText('score',progress.score);
  setText('coinCount',`${progress.coins%10}/10`);
  setText('level',progress.level);
  setText('fuelValue',`${Math.ceil(state.fuel)}٪`);
  setText('gear',state.speed<-.2?'R':Math.abs(state.speed)<.3?'N':Math.min(8,Math.floor(Math.abs(state.speed)*3.6/65)+1));
  const fuelFill=$('#fuelFill');
  if(fuelFill) {fuelFill.style.width=`${state.fuel}%`;fuelFill.classList.toggle('low',state.fuel<15);}
  const station=nearbyStation();
  setText('surface',refueling?'در حال سوخت‌گیری':station?station.name:state.fuel<=0?'باک خالی — امداد با R':world.isOnRoad(state.x,state.z)?'خیابان':'مسیر سبز');
  setText('handbrakeState',keys.handbrake?'ترمز دستی روشن':'ترمز دستی خاموش');
  $('#handbrakeState')?.classList.toggle('active',keys.handbrake);
  const refuelButton=$('#refuelButton');
  if(refuelButton) {
    refuelButton.disabled=!started||!station||Math.abs(state.speed)>1.5||state.fuel>=99.9;
    refuelButton.textContent=refueling?'در حال سوخت‌گیری…':'سوخت‌گیری';
    refuelButton.title=station?'برای سوخت‌گیری توقف کن':'نزدیک پمپ بنزین توقف کن';
  }
  const leftActive=state.signal==='left',rightActive=state.signal==='right';
  $('#indicatorLeft')?.classList.toggle('active',leftActive&&blink);
  $('#indicatorRight')?.classList.toggle('active',rightActive&&blink);
  $('#leftSignalButton')?.setAttribute('aria-pressed',String(leftActive));
  $('#rightSignalButton')?.setAttribute('aria-pressed',String(rightActive));
  $('#lightsButton')?.setAttribute('aria-pressed',String(state.lights));
  $('#speedGauge')?.style.setProperty('--speed-ratio',Math.min(1,Math.abs(state.speed)*3.6/selected.maxSpeed));
}
function clearInputs() {
  for(const key of Object.keys(keys))keys[key]=false;
  controlButtons.forEach(button=>button.classList.remove('is-active'));
}
function resetCar() {
  setAutoDriving(false);
  Object.assign(state,{x:3.5,z:54,heading:0,speed:0,steering:0,wheelSpin:0,driftAngle:0});
  if(state.fuel<=0) {state.fuel=15;showToast('امداد رسید','سوخت اضطراری دریافت شد؛ به پمپ بنزین برو');}
  refueling=false;clearInputs();renderFrames=3;
  updateVehicle(car,state,keys,.05,blink,state.lights);updateHud();
}
function start(carId=selected.id) {
  const next=getCar(carId);
  if(next.id!==selected.id) {
    scene.remove(car);disposeVehicle(car);
    selected=next;car=createVehicle(selected);scene.add(car);
    state.fuel=100;state.signal=null;resetCar();
  }
  started=true;setAutoDriving(false);audio.init();clearInputs();updateHud();
  return getState();
}
function pause() {
  started=false;setAutoDriving(false);refueling=false;state.speed=0;clearInputs();renderFrames=2;
  audio.update(0,false,false,false,false);updateHud();
  return getState();
}
function getState() {
  return {speed:Math.round(Math.abs(state.speed)*3.6),fuel:state.fuel,started,carId:selected.id,maxSpeed:selected.maxSpeed,
    position:{x:state.x,z:state.z},heading:state.heading,totalSessionCoins:progress.coins,score:progress.score,level:progress.level,
    refuelAvailable:!!nearbyStation()&&Math.abs(state.speed)<1.5,refueling,autoDriving,cameraMode,muted:audio.muted,volume:audio.volume,
    signal:state.signal,lights:state.lights,stations:world.stations.map(s=>({...s})),rendering:{software:softwareRenderer,pixelRatio:renderer.getPixelRatio(),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles}};
}
function cycleCamera() {
  cameraMode=(cameraMode+1)%3;
  setText('cameraButton',`دوربین ${cameraMode+1}/۳`);
}
function toggleSignal(side) {state.signal=state.signal===side?null:side;blinkTimer=.5;updateHud();}
function toggleLights() {state.lights=!state.lights;updateHud();}
function requestRefuel() {
  if(!started)return;
  audio.init();
  if(nearbyStation()&&Math.abs(state.speed)<1.5&&state.fuel<100)refueling=true;
  updateHud();
}
const controlByCode={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',KeyW:'up',KeyS:'down',KeyA:'left',KeyD:'right',Space:'handbrake',KeyF:'refuel'};
function isTyping(event) {
  return event.target instanceof Element && !!event.target.closest('input,textarea,select,[contenteditable="true"],dialog[open]');
}
addEventListener('keydown',event=>{
  if(!started||isTyping(event)||document.querySelector('dialog[open]'))return;
  const control=controlByCode[event.code];
  if(control) {if(autoDriving)setAutoDriving(false);keys[control]=true;event.preventDefault();return;}
  if(event.repeat)return;
  const commands={KeyR:resetCar,KeyC:cycleCamera,KeyM:()=>audio.toggle(),KeyH:()=>audio.horn(),KeyQ:()=>toggleSignal('left'),KeyE:()=>toggleSignal('right'),KeyL:toggleLights};
  if(commands[event.code]) {commands[event.code]();event.preventDefault();}
});
addEventListener('keyup',event=>{
  const control=controlByCode[event.code];
  if(control) {keys[control]=false;if(started&&!isTyping(event))event.preventDefault();}
});
for(const button of controlButtons) {
  const control=button.dataset.control;
  if(!(control in keys))continue;
  button.addEventListener('pointerdown',event=>{
    if(!started)return;
    event.preventDefault();audio.init();if(autoDriving)setAutoDriving(false);button.setPointerCapture?.(event.pointerId);
    keys[control]=true;button.classList.add('is-active');
  });
  const release=()=>{keys[control]=false;button.classList.remove('is-active');};
  button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
  button.addEventListener('contextmenu',event=>event.preventDefault());
}
const buttonActions={resetButton:resetCar,cameraButton:cycleCamera,soundButton:()=>audio.toggle(),hornButton:()=>audio.horn(),leftSignalButton:()=>toggleSignal('left'),rightSignalButton:()=>toggleSignal('right'),lightsButton:toggleLights,refuelButton:requestRefuel};
for(const [id,action] of Object.entries(buttonActions))$(`#${id}`)?.addEventListener('click',()=>{if(started){if(id==='refuelButton')setAutoDriving(false);action();}});
$('#autoDriveButton')?.addEventListener('click',()=>{if(started){audio.init();setAutoDriving(!autoDriving);}});
addEventListener('game-start',event=>start(event.detail?.carId));
addEventListener('game-menu',pause);
addEventListener('game-volume',event=>audio.setVolume(event.detail?.volume));
addEventListener('blur',()=>{setAutoDriving(false);clearInputs();refueling=false;audio.update(0,false,false,false,false);});
document.addEventListener('visibilitychange',()=>{if(document.hidden){setAutoDriving(false);clearInputs();refueling=false;audio.update(0,false,false,false,false);}});

function collision(x,z) {
  if(Math.abs(x)>CITY_HALF-3||Math.abs(z)>CITY_HALF-3)return true;
  return world.obstacles.some(o=>x>o.minX&&x<o.maxX&&z>o.minZ&&z<o.maxZ)||traffic.collide(x,z);
}
function physics(dt,controls=keys) {
  const road=world.isOnRoad(state.x,state.z);
  const maxSpeed=selected.maxSpeed/3.6*(road?1:selected.type==='suv'?.68:.38);
  const acceleration=9+selected.maxSpeed*.045;
  const braking=32+selected.maxSpeed*.04;
  const hasFuel=state.fuel>0;
  if(controls.up&&hasFuel)state.speed+=(state.speed<-.5?braking:acceleration)*dt;
  else if(controls.down) {
    if(hasFuel)state.speed+=state.speed>1?-braking*dt:-10*dt;
    else state.speed=state.speed>0?Math.max(0,state.speed-braking*dt):Math.min(0,state.speed+braking*dt);
  }
  else {
    const drag=(road?3.8:9)*dt;
    state.speed=Math.abs(state.speed)<drag?0:state.speed-Math.sign(state.speed)*drag;
  }
  if(controls.handbrake) {
    const force=38*dt;
    state.speed=Math.abs(state.speed)<force?0:state.speed-Math.sign(state.speed)*force;
  }
  state.speed=THREE.MathUtils.clamp(state.speed,-Math.min(12,maxSpeed*.35),maxSpeed);
  const steering=typeof controls.steering==='number'?controls.steering:(controls.left?1:0)-(controls.right?1:0);
  state.steering=THREE.MathUtils.damp(state.steering,steering*(controls.handbrake?.85:.58),10,dt);
  const ratio=Math.min(Math.abs(state.speed)/13,1);
  state.driftAngle=THREE.MathUtils.damp(state.driftAngle,controls.handbrake&&Math.abs(state.speed)>7?-state.steering*.45*ratio:0,controls.handbrake?5:9,dt);
  if(Math.abs(state.speed)>.08)state.heading+=state.steering*Math.sign(state.speed)*ratio*(controls.handbrake?2.3:1.6)/(1+Math.abs(state.speed)/58)*dt;
  const h=state.heading+state.driftAngle*.45;
  const distance=state.speed*dt;
  // Continuous short steps stop fast cars from jumping through a wall or another car.
  const segments=Math.max(1,Math.ceil(Math.abs(distance)/.9));
  for(let i=0;i<segments;i++) {
    const x=state.x-Math.sin(h)*distance/segments,z=state.z-Math.cos(h)*distance/segments;
    if(collision(x,z)) {
      state.speed*=-.16;
      if(progress.collisionCooldown<=0){audio.crash();progress.collisionCooldown=.8;}
      break;
    }
    state.x=x;state.z=z;
  }
  state.wheelSpin-=state.speed*dt*2.25;
  state.fuel=Math.max(0,state.fuel-dt*((Math.abs(state.speed)>.5?.04:0)+(controls.up&&hasFuel?.09:0)+Math.abs(state.speed)*.0004));
  progress.collisionCooldown=Math.max(0,progress.collisionCooldown-dt);
  const canRefuel=nearbyStation()&&Math.abs(state.speed)<1.5&&!controls.up&&!controls.down;
  if(canRefuel&&(controls.refuel||refueling)&&state.fuel<100) {
    refueling=true;state.speed=0;state.fuel=Math.min(100,state.fuel+dt*14);
    refuelSoundTimer-=dt;
    if(refuelSoundTimer<=0){audio.refuel();refuelSoundTimer=.5;}
    if(state.fuel>=100){refueling=false;showToast('باک پر شد','آمادهٔ ادامهٔ سفر');}
  } else if(!canRefuel)refueling=false;
}
const cameraTarget=new THREE.Vector3(),desiredCamera=new THREE.Vector3();
function updateCamera(dt) {
  const h=state.heading+state.driftAngle*.75;
  if(cameraMode===0) {
    const distance=9.5+Math.min(Math.abs(state.speed)/25,3);
    desiredCamera.set(state.x+Math.sin(h)*distance,5.2,state.z+Math.cos(h)*distance);
    cameraTarget.set(state.x-Math.sin(h)*7,1.2,state.z-Math.cos(h)*7);
  } else if(cameraMode===1) {
    desiredCamera.set(state.x+Math.sin(h+.9)*8,4.0,state.z+Math.cos(h+.9)*8);
    cameraTarget.set(state.x,1.05,state.z);
  } else {
    desiredCamera.set(state.x-Math.sin(h)*.35,selected.type==='suv'?2.05:1.65,state.z-Math.cos(h)*.35);
    cameraTarget.set(state.x-Math.sin(h)*30,1.25,state.z-Math.cos(h)*30);
  }
  camera.position.lerp(desiredCamera,1-Math.exp(-9*dt));camera.lookAt(cameraTarget);
  camera.fov=THREE.MathUtils.damp(camera.fov,62+Math.min(Math.abs(state.speed)/12,10),5,dt);camera.updateProjectionMatrix();
}
let previous=performance.now(),radarTimer=0,hudTimer=0;
let performanceStart=0,performanceFrames=0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt=Math.min((now-previous)/1000,.12);previous=now;
  const active=started&&!document.hidden;
  // Menus and account forms do not run physics or consume GPU with repeated identical frames.
  if(!active&&renderFrames<=0)return;
  if(!active)renderFrames--;
  traffic.update(dt,active);
  const driveInputs=active&&autoDriving?autopilot.update(state,selected.maxSpeed,collectibles.coins,traffic.cars):keys;
  if(active) {
    const previousPosition={x:state.x,z:state.z};
    physics(dt,driveInputs);collectibles.update(dt,previousPosition);
    effects.update(dt,driveInputs.handbrake&&Math.abs(state.speed)>7&&Math.abs(state.steering)>.15);
    blinkTimer+=dt;
    if(blinkTimer>.45){blinkTimer=0;blink=!blink;if(state.signal&&blink)audio.indicator();}
    audio.update(state.speed,driveInputs.up&&state.fuel>0,driveInputs.down,driveInputs.handbrake,state.fuel>0);
  }
  updateVehicle(car,state,driveInputs,dt,blink,state.lights);
  sun.position.set(state.x+80,110,state.z+65);sun.target.position.set(state.x,0,state.z);
  sky.position.set(state.x,0,state.z);
  world.update(state.x,state.z);
  updateCamera(dt);
  radarTimer+=dt;hudTimer+=dt;
  if(radarTimer>.08){drawRadar(radarTimer);radarTimer=0;}
  if(hudTimer>.12){updateHud();hudTimer=0;}
  if(toastTimer>0){toastTimer-=dt;if(toastTimer<=0)$('#levelToast')?.classList.remove('show');}
  renderer.render(scene,camera);
  if (active) {
    if (!performanceStart) performanceStart=now;
    performanceFrames++;
    if (now-performanceStart>3000) {
      const fps=performanceFrames*1000/(now-performanceStart);
      // Preserve full materials on a GPU; lower resolution only when measured frames are slow.
      if (fps<22) {
        if(renderer.shadowMap.enabled) renderer.shadowMap.enabled=false;
        const ratio=renderer.getPixelRatio();
        const minimum=softwareRenderer?.35:.75;
        if(ratio>minimum) {renderer.setPixelRatio(Math.max(minimum,ratio*.8));renderer.setSize(innerWidth,innerHeight);}
      }
      performanceStart=now;performanceFrames=0;
    }
  } else {performanceStart=0;performanceFrames=0;}
}
resetCar();camera.position.set(3.5,5.2,64);updateCamera(1);drawRadar(0);
window.carGame={start,pause,getState};
dispatchEvent(new CustomEvent('game-ready'));
requestAnimationFrame(frame);
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);renderFrames=3;});
