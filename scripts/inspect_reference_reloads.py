"""One-off evidence sheets for reload windows from local reference gameplay."""
from pathlib import Path
import os, subprocess, wave
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw
os.environ.setdefault('MPLCONFIGDIR', str(Path('temp/game-audio-reference/reload-inspection/mpl-cache').resolve()))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
OUT=Path('temp/game-audio-reference/reload-inspection'); OUT.mkdir(parents=True,exist_ok=True)
VIDEO='artifacts/audio-reference/showcase-video.webm'
FF=imageio_ffmpeg.get_ffmpeg_exe()
with wave.open('artifacts/audio-reference/showcase.wav') as w:
 sr=w.getframerate(); y=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2')/32768
for name,start,end in [('enfield',73,80),('kar98k',83,90),('mosin',107,114)]:
 times=np.arange(start,end+.01,.4)
 frames=[]
 for i,t in enumerate(times):
  raw=subprocess.check_output([FF,'-v','error','-ss',str(t),'-i',VIDEO,'-frames:v','1','-vf','scale=480:-1','-f','image2pipe','-vcodec','png','-'])
  import io
  im=Image.open(io.BytesIO(raw)).convert('RGB')
  tile=Image.new('RGB',(480,im.height+28),'white');tile.paste(im,(0,28));ImageDraw.Draw(tile).text((8,6),f'{name} {t:.2f} sec',fill='black');frames.append(tile)
 h=frames[0].height; sheet=Image.new('RGB',(480*3,h*((len(frames)+2)//3)),(225,225,225))
 for i,frame in enumerate(frames):sheet.paste(frame,((i%3)*480,(i//3)*h))
 sheet.save(OUT/f'{name}-contact-sheet.jpg')
 a=int(start*sr);b=int(end*sr);sub=y[a:b]; hop=240
 n=len(sub)//hop;env=np.sqrt(np.mean(sub[:n*hop].reshape(n,hop)**2,axis=1)); peak=np.max(np.abs(sub[:n*hop].reshape(n,hop)),axis=1)
 fig,ax=plt.subplots(figsize=(16,3));t=start+np.arange(n)*hop/sr;ax.plot(t,peak,lw=.6,label='5 ms peak');ax.plot(t,env,lw=1,label='5 ms RMS');ax.set(xlim=(start,end),xlabel='Reference video time (s)',ylabel='Amplitude',title=f'{name}: reload candidate region');ax.set_xticks(np.arange(start,end+.01,.2));ax.tick_params(axis='x',rotation=45);ax.grid();ax.legend();fig.tight_layout();fig.savefig(OUT/f'{name}-envelope.png',dpi=150);plt.close(fig)
print(OUT)
for name,start,end in [('enfield',76.,78.8),('kar98k',85.,87.6),('mosin',108.4,110.8)]:
 times=np.arange(start,end+.01,.1)
 frames=[]
 for t in times:
  raw=subprocess.check_output([FF,'-v','error','-ss',f'{t:.3f}','-i',VIDEO,'-frames:v','1','-vf','crop=iw*0.65:ih*0.65:iw*0.35:ih*0.35,scale=480:-1','-f','image2pipe','-vcodec','png','-'])
  import io
  im=Image.open(io.BytesIO(raw)).convert('RGB');tile=Image.new('RGB',(480,im.height+28),'white');tile.paste(im,(0,28));ImageDraw.Draw(tile).text((8,6),f'{name} {t:.2f} sec',fill='black');frames.append(tile)
 h=frames[0].height;sheet=Image.new('RGB',(480*4,h*((len(frames)+3)//4)),(225,225,225))
 for i,frame in enumerate(frames):sheet.paste(frame,((i%4)*480,(i//4)*h))
 sheet.save(OUT/f'{name}-detail-sheet.jpg')
