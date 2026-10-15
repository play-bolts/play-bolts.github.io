import * as THREE from 'three';

/** A small, original linear-HDR sky, filtered once for rough PBR reflection.
 * It needs no download or per-frame capture. The sky direction matches the
 * arena's sun; a broad cloud lobe gives curved rifle parts readable highlights. */
export function createOutdoorSkyTexture() {
  const width=512,height=256,data=new Uint16Array(width*height*4);
  const sun=new THREE.Vector3(-24,40,16).normalize();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    // Inverse of Three's equirectUv: data row zero is v=0, the nadir.
    const phi=((x+.5)/width-.5)*Math.PI*2,theta=((y+.5)/height-.5)*Math.PI;
    const direction=new THREE.Vector3(Math.cos(theta)*Math.cos(phi),Math.sin(theta),Math.cos(theta)*Math.sin(phi));
    const up=Math.max(0,direction.y),horizon=Math.pow(1-Math.abs(direction.y),3);
    const cloud=(Math.sin(direction.x*8+direction.z*3)*Math.sin(direction.z*7-direction.y*5)*.5+.5)*.12;
    const lobe=Math.pow(Math.max(0,direction.dot(sun)),28)*3.2;
    const color=direction.y>=0
      ?[.55+up*.12+horizon*.26+cloud+lobe,.64+up*.17+horizon*.24+cloud+lobe*.95,.73+up*.23+horizon*.20+cloud+lobe*.85]
      :[.105+horizon*.25,.105+horizon*.24,.092+horizon*.23];
    const offset=(y*width+x)*4;
    for(let channel=0;channel<3;channel++)data[offset+channel]=THREE.DataUtils.toHalfFloat(color[channel]);
    data[offset+3]=THREE.DataUtils.toHalfFloat(1);
  }
  const sky=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.HalfFloatType);
  sky.mapping=THREE.EquirectangularReflectionMapping;sky.colorSpace=THREE.LinearSRGBColorSpace;sky.needsUpdate=true;
  return sky;
}

export function createOutdoorEnvironment(renderer:THREE.WebGLRenderer) {
  const sky=createOutdoorSkyTexture();
  const generator=new THREE.PMREMGenerator(renderer),environment=generator.fromEquirectangular(sky);
  environment.texture.name='bolts-outdoor-environment';
  generator.dispose();sky.dispose();return environment;
}
