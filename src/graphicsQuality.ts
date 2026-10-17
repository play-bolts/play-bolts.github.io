/** Independent visual budgets. Touch affects the initial pixel ratio only;
 * geometry, shadow and texture budgets follow the user's quality selection. */
export function graphicsBudget(quality:string){
 return quality==='low'?{worldShadow:512,weaponShadow:512,pixels:1_500_000,ratio:1}:
  quality==='medium'?{worldShadow:1024,weaponShadow:1024,pixels:2_500_000,ratio:1}:
  {worldShadow:2048,weaponShadow:2048,pixels:4_000_000,ratio:1.75};
}
export function qualityPixelRatio(quality:string,dpr:number,width:number,height:number,touch=false){
 const budget=graphicsBudget(quality),cap=touch?Math.min(1,budget.ratio):budget.ratio;
 return Math.max(.1,Math.min(Math.max(.1,dpr),cap,Math.sqrt(budget.pixels/Math.max(1,width*height))));
}
