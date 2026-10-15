import * as THREE from 'three';

/** Metre-wide cloth cross sections on a unit-length Y axis. Animation scales
 * only Y from elbow (-.5) to wrist (+.5), preserving the existing hand rig. */
export function makeViewmodelSleeveGeometry(wristRadius=.042,elbowRadius=.074) {
  const segments=32,rings=32,positions:number[]=[],uv:number[]=[],indices:number[]=[];
  for(let j=0;j<=rings;j++) {
    const t=j/rings,y=t-.5;
    const radius=THREE.MathUtils.lerp(elbowRadius,wristRadius,Math.pow(t,.74));
    const envelope=Math.sin(t*Math.PI)**.8;
    for(let i=0;i<=segments;i++) {
      const a=i/segments*Math.PI*2;
      const folds=envelope*(.0034*Math.sin(t*27+Math.sin(a*2)*1.7)+.0017*Math.sin(t*47-a*3));
      const elbowGather=Math.exp(-Math.pow((t-.17)/.11,2))*.0024*Math.cos(a*5+t*19);
      const cuffSeam=-.0021*Math.exp(-Math.pow((t-.89)/.018,2));
      const r=radius+folds+elbowGather+cuffSeam;
      positions.push(Math.cos(a)*r,y,Math.sin(a)*r*.88);
      uv.push(i/segments,t);
      if(j<rings&&i<segments){const k=j*(segments+1)+i,n=k+segments+1;indices.push(k,n,k+1,n,n+1,k+1);}
    }
  }
  const bottom=positions.length/3;positions.push(0,-.5,0);uv.push(.5,0);
  const top=positions.length/3;positions.push(0,.5,0);uv.push(.5,1);
  for(let i=0;i<segments;i++){indices.push(bottom,i,i+1);const a=rings*(segments+1)+i;indices.push(top,a+1,a);}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();
  geometry.name='tailored-viewmodel-sleeve';return geometry;
}
