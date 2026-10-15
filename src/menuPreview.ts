import * as THREE from 'three';
import type {Faction} from './config';
import {makeRifle} from './rifle';
import {createOutdoorEnvironment} from './outdoorLighting';

function disposeObjects(root:THREE.Object3D) {
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return;
    geometries.add(object.geometry);
    for(const material of Array.isArray(object.material)?object.material:[object.material]) {
      materials.add(material);
      // Texture views belong to these models; their shared decoded images
      // remain cached for the game and subsequent previews.
      for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);
    }
  });
  geometries.forEach(geometry=>geometry.dispose());
  materials.forEach(material=>material.dispose());
  textures.forEach(texture=>texture.dispose());
}

/** A static, transparent menu portrait of the same rifle used in the round.
 * Startup loads the shared texture images before constructing this view. */
export class MenuPreview {
  private readonly renderer:THREE.WebGLRenderer;
  private readonly environment:THREE.WebGLRenderTarget;
  private readonly scene=new THREE.Scene();
  private readonly camera=new THREE.OrthographicCamera(-1,1,1,-1,.01,20);
  private readonly bounds=new THREE.Box3();
  private readonly observer:ResizeObserver|null;
  private rifle:THREE.Group|null=null;
  private faction:Faction|null=null;
  private disposed=false;
  private readonly redraw=()=>this.render();

  constructor(private readonly canvas:HTMLCanvasElement) {
    this.renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'low-power'});
    this.renderer.setClearColor(0x000000,0);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.04;
    this.environment=createOutdoorEnvironment(this.renderer);
    this.scene.environment=this.environment.texture;this.scene.environmentIntensity=.95;

    // A near-profile view preserves the full silhouette. The slight elevation
    // reveals the sights and stock thickness; negative Z projects to the left.
    this.camera.position.set(-4,.24,.18);
    this.camera.lookAt(0,0,0);
    this.camera.updateMatrixWorld(true);
    const ambient=new THREE.HemisphereLight(0xfff8eb,0x6d6659,.95);
    const key=new THREE.DirectionalLight(0xffe8c7,2.7);key.position.set(-3,5,3);
    const fill=new THREE.DirectionalLight(0xd7e3ef,1.25);fill.position.set(2,1,-4);
    this.scene.add(ambient,key,fill);

    this.observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(this.redraw):null;
    this.observer?.observe(canvas);
    if(canvas.parentElement)this.observer?.observe(canvas.parentElement);
    window.addEventListener('resize',this.redraw);
    canvas.addEventListener('webglcontextrestored',this.redraw);
  }

  show(faction:Faction):void {
    if(this.disposed)return;
    if(faction!==this.faction) {
      this.clearRifle();
      this.rifle=makeRifle(faction,false);
      this.faction=faction;
      this.rifle.position.sub(new THREE.Box3().setFromObject(this.rifle).getCenter(new THREE.Vector3()));
      this.scene.add(this.rifle);
      this.bounds.setFromObject(this.rifle);
    }
    this.render();
  }

  private render():void {
    if(this.disposed||!this.rifle)return;
    // CSS owns the 280×135 display area. Drawing-buffer changes must not
    // change that layout, including when the menu temporarily becomes hidden.
    const rect=this.canvas.getBoundingClientRect();
    const width=Math.max(1,Math.round(rect.width||280)),height=Math.max(1,Math.round(rect.height||135));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    this.renderer.setSize(width,height,false);
    const viewBounds=new THREE.Box3();
    for(const x of [this.bounds.min.x,this.bounds.max.x])for(const y of [this.bounds.min.y,this.bounds.max.y])for(const z of [this.bounds.min.z,this.bounds.max.z]) {
      viewBounds.expandByPoint(new THREE.Vector3(x,y,z).applyMatrix4(this.camera.matrixWorldInverse));
    }
    const aspect=width/height,halfX=Math.max(Math.abs(viewBounds.min.x),Math.abs(viewBounds.max.x));
    const halfY=Math.max(Math.abs(viewBounds.min.y),Math.abs(viewBounds.max.y));
    const vertical=Math.max(halfY,halfX/aspect)/.90;
    this.camera.left=-vertical*aspect;this.camera.right=vertical*aspect;
    this.camera.top=vertical;this.camera.bottom=-vertical;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene,this.camera);
  }

  private clearRifle():void {
    if(!this.rifle)return;
    this.scene.remove(this.rifle);
    disposeObjects(this.rifle);
    this.rifle=null;
  }

  dispose():void {
    if(this.disposed)return;
    this.disposed=true;
    this.observer?.disconnect();
    window.removeEventListener('resize',this.redraw);
    this.canvas.removeEventListener('webglcontextrestored',this.redraw);
    this.clearRifle();
    this.scene.clear();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
