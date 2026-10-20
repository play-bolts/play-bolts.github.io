import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

export default defineConfig({
 build:{rollupOptions:{input:{
  game:fileURLToPath(new URL('./index.html',import.meta.url)),
  soundReview:fileURLToPath(new URL('./sound-review.html',import.meta.url)),
 }}},
});
