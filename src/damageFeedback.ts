/** Brief full-screen red pulse, with a longer hold for a lethal hit. */
export function damageFlashOpacity(elapsedMs:number,lethal=false):number {
 if(!Number.isFinite(elapsedMs)||elapsedMs<0)return 0;
 const hold=lethal?180:65,duration=lethal?1100:620;
 if(elapsedMs>=duration)return 0;
 return (lethal?.92:.72)*Math.pow(1-Math.max(0,elapsedMs-hold)/(duration-hold),1.45);
}
