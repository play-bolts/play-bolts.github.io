import type {BufferGeometry} from 'three';
const originals=new WeakMap<BufferGeometry,BufferGeometry>();
/** Only immutable loaded templates participate. Actor copies retain their own
 * attributes; this identity permits one bake validation per source revision. */
export function rememberLodGeometryClone(source:BufferGeometry,copy:BufferGeometry){originals.set(copy,originals.get(source)??source);}
export const lodGeometrySource=(geometry:BufferGeometry)=>originals.get(geometry);
