/** A model has exactly one owner: an active actor or one bounded idle slot.
 * Keeping that slot alive retains uploaded geometry, textures and programs.
 * The pool never shares mutable skeletons or hand geometry between actors. */
export class ModelPool<K,M extends object>{
 private readonly idle=new Map<K,M[]>();
 private readonly owners=new Map<M,K>();
 private readonly active=new Set<M>();
 constructor(private readonly create:(key:K)=>M,private readonly reset:(model:M)=>void,private readonly dispose:(model:M)=>void,private readonly limit=1){}
 acquire(key:K):M{
  const model=this.idle.get(key)?.pop()??this.create(key);
  this.owners.set(model,key);this.active.add(model);this.reset(model);return model;
 }
 release(model:M){
  if(!this.active.delete(model))throw new Error('Model was not leased from this pool');
  const key=this.owners.get(model)!;let bucket=this.idle.get(key);if(!bucket){bucket=[];this.idle.set(key,bucket);}
  if(bucket.length<this.limit)bucket.push(model);else{this.owners.delete(model);this.dispose(model);}
 }
 /** Releases only unused models; leased models retain their original owner. */
 clearIdle(){for(const models of this.idle.values())for(const model of models){this.owners.delete(model);this.dispose(model);}this.idle.clear();}
 get retained(){let count=0;for(const models of this.idle.values())count+=models.length;return count;}
}
