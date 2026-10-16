import actorFields from '../shared/actor-fields.json';

/** Stateless full snapshots use positional fields to avoid repeating actor
 * property names twenty times per second. No deltas or numeric rounding: any
 * received state remains independently decodable after intermediate loss. */
export function decodeSnapshot(value:unknown):unknown {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const snapshot=value as Record<string,unknown>;
 if(snapshot.actorEncoding===undefined)return value; // joined state is named
 if(snapshot.actorEncoding!=='tuple-v1'||!Array.isArray(snapshot.actors)||snapshot.actors.length<1||snapshot.actors.length>6)return null;
 const actors:Record<string,unknown>[]=[];
 for(const tuple of snapshot.actors){
  if(!Array.isArray(tuple)||tuple.length!==actorFields.length)return null;
  const actor:Record<string,unknown>={};
  for(let index=0;index<actorFields.length;index++)actor[actorFields[index]]=tuple[index];
  actors.push(actor);
 }
 const {actorEncoding:_,...rest}=snapshot;
 return {...rest,actors};
}
