"""Repack official soldier adaptations without touching geometry or UV buffers.

Opaque source base color: original resolution, JPEG92. Alpha color and all
normal/ORM data: lossless PNG. Images are decoded from final embedded bytes,
avoiding Blender's packed-image metadata/resizing discrepancy.
"""
from pathlib import Path
from PIL import Image
import io,json,struct,hashlib,sys
ROOT=Path(__file__).resolve().parents[1]
for name in sys.argv[1:] or ['british','german','russian']:
 target=ROOT/f'public/assets/imported-soldiers/{name}.glb';raw=target.read_bytes()
 length=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+length]);binary=raw[28+length:]
 color=set();alpha=set()
 for material in doc.get('materials',[]):
  texture=material.get('pbrMetallicRoughness',{}).get('baseColorTexture')
  if texture:
   index=doc['textures'][texture['index']]['source'];color.add(index)
   if material.get('alphaMode','OPAQUE')!='OPAQUE':alpha.add(index)
 replacements={};records=[]
 for index,entry in enumerate(doc.get('images',[])):
  view=doc['bufferViews'][entry['bufferView']];start=view.get('byteOffset',0)
  im=Image.open(io.BytesIO(binary[start:start+view['byteLength']])).convert('RGBA' if index in alpha else 'RGB')
  limit=1024 if index in color else 512
  if max(im.size)>limit:im.thumbnail((limit,limit),Image.Resampling.LANCZOS)
  data=io.BytesIO()
  if index in color and index not in alpha:
   im.save(data,format='JPEG',quality=92,subsampling=0,optimize=True);entry['mimeType']='image/jpeg'
  else:im.save(data,format='PNG',optimize=True,compress_level=9);entry['mimeType']='image/png'
  replacements[entry['bufferView']]=data.getvalue()
  records.append(dict(name=entry.get('name',str(index)),dimensions=list(im.size),mimeType=entry['mimeType'],bytes=len(data.getvalue())))
 payload=bytearray()
 for index,view in enumerate(doc['bufferViews']):
  payload+=b'\0'*((-len(payload))%4)
  start=view.get('byteOffset',0);data=replacements.get(index,binary[start:start+view['byteLength']])
  view['byteOffset']=len(payload);view['byteLength']=len(data);payload.extend(data)
 doc['buffers'][0]['byteLength']=len(payload)
 encoded=json.dumps(doc,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4);payload+=b'\0'*((-len(payload))%4)
 result=struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(payload))+struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(payload),b'BIN\0')+payload
 target.write_bytes(result)
 for entry,record in zip(doc['images'],records):
  view=doc['bufferViews'][entry['bufferView']];im=Image.open(io.BytesIO(payload[view['byteOffset']:view['byteOffset']+view['byteLength']]))
  assert list(im.size)==record['dimensions'] and max(im.size)<=1024
 assert len(result)<25_000_000, 'runtime asset exceeds hosting budget'
 provenance=target.with_name(name+'-provenance.json');manifest=json.loads(provenance.read_text());manifest['outputSha256']=hashlib.sha256(result).hexdigest();manifest['outputBytes']=len(result);manifest['embeddedTextures']=records
 note='Opaque color textures JPEG92 and alpha color lossless PNG at source resolution up to1K; normal and ORM maps lossless PNG up to512px; actual embedded image bytes verified.'
 if note not in manifest['modifications']:manifest['modifications'].append(note)
 provenance.write_text(json.dumps(manifest,indent=2)+'\n');print(name,len(raw),'->',len(result))
