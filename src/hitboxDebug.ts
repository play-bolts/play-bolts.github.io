import * as THREE from 'three';
import type {HitVolume} from './hitboxes';

// Development inspector only. The production scene does not import this
// overlay; the spheres use the exact damage volumes sampled by the game.
const colors:Record<string,number>={head:0xffd75a,torso:0x61d9ef,lowerTorso:0x78e299,limb:0xfd9b7e,lowerLimb:0xa9a1ff,extremity:0xf6a6dc};
export class HitboxDebug extends THREE.Group {
  private geometry=new THREE.SphereGeometry(1,16,10);
  private materials=new Map<string,THREE.MeshBasicMaterial>();
  update(volumes:HitVolume[]){
    while(this.children.length<volumes.length)this.add(new THREE.Mesh(this.geometry));
    this.children.forEach((object,index)=>{
      const volume=volumes[index],mesh=object as THREE.Mesh;
      mesh.visible=!!volume;if(!volume)return;
      let material=this.materials.get(volume.part);
      if(!material){material=new THREE.MeshBasicMaterial({color:colors[volume.part]??0xffffff,wireframe:true,transparent:true,opacity:.65,depthTest:false,depthWrite:false});this.materials.set(volume.part,material);}
      mesh.material=material;mesh.renderOrder=10;mesh.name=volume.name;
      mesh.position.set(volume.center.x,volume.center.y,volume.center.z);
      mesh.scale.set(volume.halfSize.x,volume.halfSize.y,volume.halfSize.z);
      mesh.quaternion.fromArray(volume.rotation);
    });
  }
}
