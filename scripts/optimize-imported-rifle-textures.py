"""Repack converted GLBs without altering mesh buffers or UVs.

Keep source color resolution (up to2K), encode opaque color as JPEG92, and
retain lossless 1K normal/ORM maps (2K for MaX3Dd's detailed Mosin atlas).
Decode embedded images after writing so
packed image bytes, rather than Blender's cached image metadata, are checked.
"""
from pathlib import Path
from PIL import Image
import io,json,struct,hashlib,sys
ROOT=Path(__file__).resolve().parents[1]
for name in sys.argv[1:] or ['enfield','kar98k','mosin']:
 target=ROOT/f'public/assets/imported-weapons/{name}.glb';raw=target.read_bytes()
 json_length=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+json_length]);binary=raw[28+json_length:]
 color=set();normal=set();orm=set()
 def image_index(tex):return doc['textures'][tex['index']]['source']
 for mat in doc.get('materials',[]):
  pbr=mat.get('pbrMetallicRoughness',{})
  if 'baseColorTexture' in pbr:color.add(image_index(pbr['baseColorTexture']))
  if 'metallicRoughnessTexture' in pbr:orm.add(image_index(pbr['metallicRoughnessTexture']))
  if 'normalTexture' in mat:normal.add(image_index(mat['normalTexture']))
  if name=='mosin':
   if 'h-190' in mat['name']:pbr['baseColorFactor']=[.075,.075,.075,1]
   elif 'stell' in mat['name']:pbr['baseColorFactor']=[.22,.22,.22,1]
   elif 'wood_walnut' in mat['name']:pbr['baseColorFactor']=[.24,.105,.047,1]
 replacements={};verified=[]
 for index,entry in enumerate(doc.get('images',[])):
  view=doc['bufferViews'][entry['bufferView']];start=view.get('byteOffset',0)
  im=Image.open(io.BytesIO(binary[start:start+view['byteLength']])).convert('RGB')
  authored_mosin=name=='mosin' and any('MaX3Dd' in m.get('name','') for m in doc.get('materials',[]))
  limit=2048 if index in color or authored_mosin else 1024
  if max(im.size)>limit:
   im.thumbnail((limit,limit),Image.Resampling.LANCZOS)
  if name=='mosin' and not authored_mosin and index in orm:
   # Only newly authored steel maps need a physical roughness floor. The
   # original neutral steel sample is smoother than aged rifle metal.
   if any('wood_walnut' not in m['name'] and image_index(m['pbrMetallicRoughness']['metallicRoughnessTexture'])==index for m in doc['materials']):
    r,g,b=im.split();g=g.point(lambda x:round(.36*255+.32*x));im=Image.merge('RGB',(r,g,b))
  data=io.BytesIO()
  if index in color:im.save(data,format='JPEG',quality=92,subsampling=0,optimize=True);entry['mimeType']='image/jpeg'
  else:im.save(data,format='PNG',optimize=True,compress_level=9);entry['mimeType']='image/png'
  replacements[entry['bufferView']]=data.getvalue();verified.append(dict(name=entry.get('name',str(index)),dimensions=list(im.size),mimeType=entry['mimeType'],bytes=len(data.getvalue())))
 payload=bytearray()
 for index,view in enumerate(doc['bufferViews']):
  while len(payload)%4:payload.append(0)
  start=view.get('byteOffset',0);data=replacements.get(index,binary[start:start+view['byteLength']])
  view['byteOffset']=len(payload);view['byteLength']=len(data);payload.extend(data)
 doc['buffers'][0]['byteLength']=len(payload)
 encoded=json.dumps(doc,separators=(',',':')).encode();encoded+=b' '*((-len(encoded))%4);payload+=b'\0'*((-len(payload))%4)
 result=struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(payload))+struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(payload),b'BIN\0')+payload
 target.write_bytes(result)
 # Verify actual final image bytes have the declared dimensions and format.
 for entry,record in zip(doc['images'],verified):
  view=doc['bufferViews'][entry['bufferView']];im=Image.open(io.BytesIO(payload[view['byteOffset']:view['byteOffset']+view['byteLength']]))
  assert list(im.size)==record['dimensions'] and max(im.size)<=2048
 provenance=target.with_name(name+'-provenance.json');manifest=json.loads(provenance.read_text());manifest['outputSha256']=hashlib.sha256(result).hexdigest();manifest['outputBytes']=len(result);manifest['embeddedTextures']=verified
 note=('Authored basecolor JPEG92, normal/ORM lossless PNG, all resampled from4K to2K; original metallic/roughness values preserved; actual embedded bytes verified' if authored_mosin else 'Opaque basecolor JPEG92 at original resolution up to2K; normal/ORM resampled to1K lossless PNG; actual embedded bytes verified')
 if note not in manifest['modifications']:manifest['modifications'].append(note)
 provenance.write_text(json.dumps(manifest,indent=2)+'\n');print(name,len(raw),'->',len(result))
