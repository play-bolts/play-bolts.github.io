/** Patch only changed values; continuous values are still sampled every frame. */
export function hudText(element:HTMLElement,value:string){if(element.textContent!==value)element.textContent=value;}
export function hudClass(element:Element,name:string,enabled:boolean){if(element.classList.contains(name)!==enabled)element.classList.toggle(name,enabled);}
const styleValues=new WeakMap<HTMLElement,Map<string,{value:string;serialized:string}>>();
export function hudStyle(element:HTMLElement,property:string,value:string){
 const current=element.style.getPropertyValue(property);let properties=styleValues.get(element),previous=properties?.get(property);
 // CSSOM can normalize colors or round transforms. Remember that serialized
 // form too, while detecting changes made outside the per-frame HUD writer.
 if(current===value||previous?.value===value&&previous.serialized===current)return;
 element.style.setProperty(property,value);
 if(!properties){properties=new Map();styleValues.set(element,properties);}
 if(!previous){previous={value,serialized:''};properties.set(property,previous);}
 previous.value=value;previous.serialized=element.style.getPropertyValue(property);
}

/** Trusted markup is rebuilt only when the inputs to that markup change. */
export class HudMarkup {
 private keys=new WeakMap<HTMLElement,string>();
 set(element:HTMLElement,key:string,render:()=>string){if(this.keys.get(element)===key)return;this.keys.set(element,key);element.innerHTML=render();}
}
