/** Export a portable review page with no server, external assets or AI requests.
 * Run: node --import tsx scripts/export-sound-review-html.ts
 * Regenerate after adding candidates; the checked-in Vite page stays unchanged. */
import {build,type Plugin} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const publicRoot=join(root,'public'),output=join(root,'temp','sound-review.html');
const counts=new Map<string,number>();
function publicAsset(file:string){
 if(!file.startsWith('/assets/'))throw new Error(`Expected a public asset path: ${file}`);
 const path=resolve(publicRoot,`.${file}`);
 if(!path.startsWith(publicRoot+sep))throw new Error(`Asset escaped public directory: ${file}`);
 return path;
}
const embeddedAssets:Plugin={
 name:'embedded-review-assets',
 setup(bundler){
  bundler.onLoad({filter:/[/\\]shared[/\\](?:audio-candidates|kill-voices|game-audio)\.json$/},async({path})=>{
   const entries:({id:string;file:string}&Record<string,unknown>)[]=JSON.parse(await readFile(path,'utf8'));
   if(new Set(entries.map(entry=>entry.id)).size!==entries.length)throw new Error(`Duplicate sound IDs in ${path}`);
   const embedded=await Promise.all(entries.map(async entry=>{
    if(extname(entry.file)!=='.wav')throw new Error(`Expected a WAV preview: ${entry.file}`);
    const bytes=await readFile(publicAsset(entry.file));
    return{...entry,file:`data:audio/wav;base64,${bytes.toString('base64')}`};
   }));
   counts.set(path,entries.length);
   return{contents:JSON.stringify(embedded),loader:'json'};
  });
  // The shared stylesheet includes the title font and menu artwork. Embed those
  // too, so even a future matching selector cannot issue a filesystem request.
  bundler.onResolve({filter:/^\/assets\//},({path})=>({path:publicAsset(path)}));
  bundler.onResolve({filter:/^(?:https?:)?\/\//},({path})=>({errors:[{text:`External review dependency is not portable: ${path}`}]}));
 },
};

const result=await build({
 absWorkingDir:root,entryPoints:['src/soundReviewPage.ts'],outfile:join(root,'temp','sound-review.bundle.js'),
 bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,
 sourcemap:false,charset:'utf8',legalComments:'none',metafile:true,
 loader:{'.ttf':'dataurl','.woff':'dataurl','.woff2':'dataurl','.webp':'dataurl','.png':'dataurl','.svg':'dataurl'},
 plugins:[embeddedAssets],
 footer:{js:`// Give embedded candidates useful filenames in browser downloads.
for(const link of document.querySelectorAll('.sound-candidate a[download]')){
 const preview=link.parentElement?.querySelector('[data-sound-preview]')?.dataset.soundPreview;
 if(preview?.startsWith('candidate:'))link.download=preview.slice(10)+'.wav';
}`},
});
if(Object.values(result.metafile!.outputs).some(item=>item.imports.some(dependency=>!dependency.path.startsWith('data:'))))throw new Error('Review bundle still has external dependencies');
const javascript=result.outputFiles.find(file=>file.path.endsWith('.js'))?.text;
const css=result.outputFiles.find(file=>file.path.endsWith('.css'))?.text;
if(!javascript||!css||result.outputFiles.length!==2)throw new Error('Expected one inline script and stylesheet');
if(counts.size!==3)throw new Error('All three audio manifests must be embedded');
const template=await readFile(join(root,'sound-review.html'),'utf8');
const entry='<script type="module" src="/src/soundReviewPage.ts"></script>';
if(!template.includes(entry))throw new Error('Review page entry changed; update the portable exporter');
const html=template
 .replace('</head>',()=>`<style>${css.replace(/<\/style/gi,'<\\/style')}</style>\n </head>`)
 .replace(entry,()=>`<script>${javascript.replace(/<\/script/gi,'<\\/script')}</script>`);
await mkdir(dirname(output),{recursive:true});
await writeFile(output,html);
const candidates=counts.get(join(root,'shared','audio-candidates.json'))!,voices=counts.get(join(root,'shared','kill-voices.json'))!,game=counts.get(join(root,'shared','game-audio.json'))!;
console.log(`Exported ${output}: ${game} current gameplay clips, ${candidates} AI candidates, ${voices} current voices, and procedural combat/DSP previews (${(Buffer.byteLength(html)/1024/1024).toFixed(1)} MiB). Open this file directly in a browser.`);
