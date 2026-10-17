/** npm run dev -- --config scripts/performance-vite.config.ts --port 5184
 * Fixed profiling session: no HMR; same-origin measurements saved under temp/.
 */
import {defineConfig} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export default defineConfig({server:{host:'127.0.0.1',hmr:false},plugins:[{
 name:'local-performance-results',configureServer(server){
  server.middlewares.use(async(req,res,next)=>{
   const match=/^\/__performance-results\/(renderer|session|animation)$/.exec(req.url??'');
   if(!match)return next();
   if(req.method!=='POST'||req.headers.origin!==`http://${req.headers.host}`){res.statusCode=403;res.end();return;}
   try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>5_000_000)throw new Error('Report too large');}
    const parsed=JSON.parse(body),directory=resolve('temp/performance-audit');await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,`browser-${match[1]}.json`),JSON.stringify(parsed,null,2)+'\n');res.statusCode=204;res.end();
   }catch(error){res.statusCode=400;res.end(String(error));}
  });
 }
}]});
